import { sectorKey } from "./screen.js";
import { z } from "zod";
import type { StrategyConfig } from "./config.js";
import { configDigest, StrategyConfigSchema } from "./config.js";
import type { ScreenResult } from "./screen.js";
import { StrategySourceSchema, isoDateTime, tickerSchema } from "./schema.js";
import { contentHashOf } from "./journal.js";
import { parseQuarter, quarterEnd } from "../domain/time.js";
import { epoch } from "./time.js";

// One-cohort replay accounting (STRATEGY_SPEC.md "Replay accounting and measurements"). Deliberately takes a
// ScreenResult produced earlier (never recomputes eligibility here), so future prices can never influence who was
// selected. A missing session/price for a selected ticker or either benchmark makes the WHOLE run "incomplete": no
// numeric performance is fabricated, and a missing outcome never promotes a runner-up into the selection.

const priceOrNull = z.number().positive().max(1e9).nullable();
export const SessionSchema = z.object({ openAt: isoDateTime, closeAt: isoDateTime }).strict().refine((s) => epoch(s.openAt) < epoch(s.closeAt), "openAt must be before closeAt");
export const ExchangeCalendarSchema = z
  .object({ provider: z.string().trim().min(1).max(100), adjustmentBasis: z.literal("total_return"), sessions: z.array(SessionSchema).min(1).max(250) })
  .strict()
  .refine((c) => c.sessions.every((s, i) => i === 0 || epoch(c.sessions[i - 1]!.closeAt) < epoch(s.openAt)), { message: "sessions must be in strictly ascending, non-overlapping chronological order (one common calendar)", path: ["sessions"] });
export type ExchangeCalendar = z.infer<typeof ExchangeCalendarSchema>;

export const PriceSeriesSchema = z
  .object({
    label: z.union([tickerSchema, z.literal("MARKET_BENCHMARK"), z.literal("SECTOR_BENCHMARK")]),
    provider: z.string().trim().min(1).max(100),
    adjustmentBasis: z.literal("total_return"), // dividends already included; replay never adds them again
    source: StrategySourceSchema, // known-at historical prices, used only as realized outcomes, never as screening input
    prices: z.array(z.object({ open: priceOrNull, close: priceOrNull }).strict()).min(1).max(250),
  })
  .strict();
export type PriceSeries = z.infer<typeof PriceSeriesSchema>;

export const RealizedEpsSchema = z.object({ ticker: tickerSchema, quarter: z.string().regex(/^\d{4}Q[1-4]$/), epsKRW: z.number().finite(),
  scope: z.literal("consolidated"), basis: z.literal("common_diluted"), unit: z.literal("KRW_per_share"), source: StrategySourceSchema }).strict();

export const ReplayInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    decisionAt: isoDateTime,
    calendar: ExchangeCalendarSchema,
    marketBenchmark: PriceSeriesSchema,
    sectorBenchmark: PriceSeriesSchema,
    tickerPrices: z.array(PriceSeriesSchema).max(50),
    realizedEps: z.array(RealizedEpsSchema).max(200).optional(),
  })
  .strict()
  .refine((r) => new Set((r.realizedEps ?? []).map((v) => `${v.ticker}:${v.quarter}`)).size === (r.realizedEps?.length ?? 0), "duplicate ticker-quarter realized EPS")
  .refine((r) => r.marketBenchmark.label === "MARKET_BENCHMARK", { message: "marketBenchmark.label must be MARKET_BENCHMARK", path: ["marketBenchmark", "label"] })
  .refine((r) => r.sectorBenchmark.label === "SECTOR_BENCHMARK", { message: "sectorBenchmark.label must be SECTOR_BENCHMARK", path: ["sectorBenchmark", "label"] })
  .refine((r) => new Set(r.tickerPrices.map((t) => t.label)).size === r.tickerPrices.length, { message: "duplicate ticker in tickerPrices", path: ["tickerPrices"] })
  .refine((r) => r.tickerPrices.every((t) => t.prices.length === r.calendar.sessions.length), { message: "every price series must have exactly one entry per calendar session", path: ["tickerPrices"] })
  .refine((r) => r.marketBenchmark.prices.length === r.calendar.sessions.length && r.sectorBenchmark.prices.length === r.calendar.sessions.length, { message: "benchmark price series must have exactly one entry per calendar session", path: ["calendar", "sessions"] });
export type ReplayInput = z.infer<typeof ReplayInputSchema>;

export type CostBreakdown = { entrySlippageKRW: number; entryFeeKRW: number; exitSlippageKRW: number; exitFeeKRW: number; exitTaxKRW: number; totalCostKRW: number };

export type PositionResult = {
  ticker: string;
  weight: number;
  budgetKRW: number;
  entryOpenKRW: number;
  effectiveEntryCostKRW: number;
  units: number;
  exitCloseKRW: number;
  exitProceedsPerUnitKRW: number;
  grossExitValueKRW: number; // units * exitClose, no costs at all
  netExitValueKRW: number; // units * exitProceedsPerUnit
};

export type ForecastAccuracy = { ticker: string; forecastNtmEpsKRW: number; realizedNtmEpsKRW: number; errorKRW: number; errorPct: number | null; reason: string | null };

type ReplayMetadata = {
  experimentMode: ScreenResult["experimentMode"];
  evaluatedAt: string;
  config: StrategyConfig;
  outcomeInputHash: string;
  outcomeProvenance: { calendar: ExchangeCalendar; series: Omit<PriceSeries, "prices">[] };
  selection: ScreenResult;
  evidenceModes: Record<string, string>;
};

export type ReplayResult =
  ReplayMetadata & ( {
      status: "incomplete";
      decisionAt: string;
      configDigest: string;
      missing: { subject: string; reason: string }[];
    }
  | {
      status: "no_trade" | "completed";
      decisionAt: string;
      configDigest: string;
      entryOpenAt: string;
      exitCloseAt: string;
      initialCapitalKRW: number;
      idleCashKRW: number;
      positions: PositionResult[];
      costs: CostBreakdown;
      equityCurve: number[]; // index 0 = pre-entry capital; length = sessions.length + 1
      finalEquityKRW: number;
      grossReturnPct: number;
      netReturnPct: number;
      marketReturnPct: number;
      sectorReturnPct: number;
      excessReturnVsMarketPct: number;
      excessReturnVsSectorPct: number;
      maxDrawdownPct: number;
      turnover: { buyNotionalKRW: number; sellNotionalKRW: number; totalNotionalToInitialCapital: number };
      cashWeightedSectorReturnPct: number;
      excessReturnVsCashWeightedSectorPct: number;
      evidenceModes: Record<string, string>;
      forecastAccuracy: ForecastAccuracy[];
      selection: ScreenResult;
      notes: string[];
    });

// Candidates may span multiple user-declared sectors, but ReplayInput carries exactly one sectorBenchmark series.
// It is NOT automatically selected, matched, or weighted to the actual mix of selected sectors -- it is whatever
// single benchmark the caller supplied. Treat sectorReturnPct/excessReturnVsSectorPct/cashWeightedSectorReturnPct
// as a comparison against that one caller-chosen index, not a proper mixed-sector benchmark.
const SECTOR_BENCHMARK_NOTE = "sectorBenchmark is a single caller-supplied series, not an automatically matched or weighted mixed-sector benchmark; sectorReturnPct and its derivatives compare only against that one index.";

const simpleReturnPct = (openFirst: number, closeLast: number): number => (closeLast / openFirst - 1) * 100;

function maxDrawdownPct(curve: number[]): number {
  let peak = curve[0]!;
  let worst = 0;
  for (const v of curve) {
    peak = Math.max(peak, v);
    worst = Math.max(worst, (peak - v) / peak);
  }
  return worst * 100;
}

export function replay(input: ReplayInput, selection: ScreenResult, config: StrategyConfig, evaluatedAt: Date = new Date()): ReplayResult {
  input = ReplayInputSchema.parse(input);
  config = StrategyConfigSchema.parse(config);
  const digest = configDigest(config);
  const sessions = input.calendar.sessions;
  const missing: { subject: string; reason: string }[] = [];
  const metadata: ReplayMetadata = {
    experimentMode: selection.experimentMode, evaluatedAt: evaluatedAt.toISOString(), config,
    outcomeInputHash: contentHashOf(input), selection, evidenceModes: selection.evidenceModes,
    outcomeProvenance: { calendar: input.calendar, series: [input.marketBenchmark, input.sectorBenchmark, ...input.tickerPrices].map(({ prices: _prices, ...s }) => s) },
  };
  const sectors = new Map(selection.inputSnapshots.map((c) => [c.ticker, sectorKey(c.forecast.sector)]));
  const sectorTotals = new Map<string, number>();
  for (const position of selection.selected) {
    const sector = sectors.get(position.ticker);
    if (sector === undefined) missing.push({ subject: position.ticker, reason: "Selected ticker has no sector input" });
    else sectorTotals.set(sector, (sectorTotals.get(sector) ?? 0) + position.weight);
  }
  const weights = selection.selected.map((s) => s.weight);
  if (new Set(selection.selected.map((s) => s.ticker)).size !== selection.selected.length || weights.some((w) => !Number.isFinite(w) || w <= 0 || w > config.maxWeightPerHolding)
      || weights.reduce((n, w) => n + w, 0) > 1 + 1e-12
      || [...sectorTotals.values()].some((w) => w > config.risk.maxSectorWeight + 1e-12))
    missing.push({ subject: "selection", reason: "Duplicate positions or weights violating position/sector/cash limits" });
  const finalClose = epoch(sessions.at(-1)!.closeAt);
  if (selection.experimentMode !== "synthetic") {
    if (finalClose > evaluatedAt.getTime()) missing.push({ subject: "outcomes", reason: "Holding window is not yet complete; future paths cannot be reported as observed returns" });
    const selectedTickers = new Set(selection.selected.map((s) => s.ticker));
    for (const s of [input.marketBenchmark, input.sectorBenchmark, ...input.tickerPrices.filter((s) => selectedTickers.has(s.label))]) {
      if (epoch(s.source.knownAt) < finalClose || epoch(s.source.knownAt) > evaluatedAt.getTime())
        missing.push({ subject: s.label, reason: "Outcome dataset must be known after the final session and no later than evaluation" });
    }
    for (const r of input.realizedEps ?? []) {
      const periodEnd = epoch(`${quarterEnd(parseQuarter(r.quarter))}T23:59:59+09:00`);
      if (epoch(r.source.knownAt) > evaluatedAt.getTime() || epoch(r.source.knownAt) <= periodEnd)
        missing.push({ subject: `${r.ticker}:${r.quarter}`, reason: "Realized EPS must be published after its fiscal period and known by evaluation" });
    }
  }

  if (sessions.length !== config.holdSessions) missing.push({ subject: "calendar", reason: `calendar has ${sessions.length} sessions, config.holdSessions requires exactly ${config.holdSessions}` });
  if (epoch(input.decisionAt) >= epoch(sessions[0]!.openAt)) missing.push({ subject: "decisionAt", reason: "decisionAt must be strictly before the first session's openAt (no same-close fills)" });
  if (selection.configDigest !== digest) missing.push({ subject: "selection", reason: "selection.configDigest does not match the supplied config (a replay must reuse the exact config that produced the selection)" });
  if (epoch(input.decisionAt) !== epoch(selection.decisionAt)) missing.push({ subject: "selection", reason: "selection.decisionAt does not match input.decisionAt" });

  const checkSeries = (label: string, series: PriceSeries) => {
    series.prices.forEach((p, i) => {
      if (p.open === null || p.close === null) missing.push({ subject: label, reason: `no price for session ${i} (${sessions[i]?.openAt} - ${sessions[i]?.closeAt})` });
    });
  };
  checkSeries("MARKET_BENCHMARK", input.marketBenchmark);
  checkSeries("SECTOR_BENCHMARK", input.sectorBenchmark);
  const byTicker = new Map(input.tickerPrices.map((t) => [t.label, t]));
  for (const s of selection.selected) {
    const series = byTicker.get(s.ticker);
    if (!series) missing.push({ subject: s.ticker, reason: "no price series supplied for a selected ticker" });
    else checkSeries(s.ticker, series);
  }

  if (missing.length) return { ...metadata, status: "incomplete", decisionAt: input.decisionAt, configDigest: digest, missing };

  const lastIdx = sessions.length - 1;
  const feeRate = config.feeBpsPerSide / 10_000;
  const slipRate = config.slippageBpsPerSide / 10_000;
  const taxRate = config.sellTaxBps / 10_000;
  const capital = config.initialCapitalKRW;

  const evidenceModes = selection.evidenceModes;

  if (selection.selected.length === 0) {
    const marketReturnPct = simpleReturnPct(input.marketBenchmark.prices[0]!.open!, input.marketBenchmark.prices[lastIdx]!.close!);
    const sectorReturnPct = simpleReturnPct(input.sectorBenchmark.prices[0]!.open!, input.sectorBenchmark.prices[lastIdx]!.close!);
    return {
      ...metadata,
      status: "no_trade",
      decisionAt: input.decisionAt,
      configDigest: digest,
      entryOpenAt: sessions[0]!.openAt,
      exitCloseAt: sessions[lastIdx]!.closeAt,
      initialCapitalKRW: capital,
      idleCashKRW: capital,
      positions: [],
      costs: { entrySlippageKRW: 0, entryFeeKRW: 0, exitSlippageKRW: 0, exitFeeKRW: 0, exitTaxKRW: 0, totalCostKRW: 0 },
      equityCurve: Array(sessions.length + 1).fill(capital),
      finalEquityKRW: capital,
      grossReturnPct: 0,
      netReturnPct: 0,
      marketReturnPct,
      sectorReturnPct,
      excessReturnVsMarketPct: 0 - marketReturnPct,
      excessReturnVsSectorPct: 0 - sectorReturnPct,
      maxDrawdownPct: 0,
      turnover: { buyNotionalKRW: 0, sellNotionalKRW: 0, totalNotionalToInitialCapital: 0 },
      cashWeightedSectorReturnPct: 0,
      excessReturnVsCashWeightedSectorPct: 0,
      evidenceModes,
      forecastAccuracy: [],
      selection,
      notes: ["No eligible candidates cleared the screen; all capital stays in cash for the full holding window.",
        SECTOR_BENCHMARK_NOTE],
    };
  }

  const positions: PositionResult[] = selection.selected.map((s) => {
    const series = byTicker.get(s.ticker)!;
    const entryOpenKRW = series.prices[0]!.open!;
    const exitCloseKRW = series.prices[lastIdx]!.close!;
    const effectiveEntryCostKRW = entryOpenKRW * (1 + slipRate) * (1 + feeRate);
    const budgetKRW = capital * s.weight;
    const units = budgetKRW / effectiveEntryCostKRW;
    const exitProceedsPerUnitKRW = exitCloseKRW * (1 - slipRate) * (1 - feeRate - taxRate);
    return { ticker: s.ticker, weight: s.weight, budgetKRW, entryOpenKRW, effectiveEntryCostKRW, units, exitCloseKRW, exitProceedsPerUnitKRW, grossExitValueKRW: units * exitCloseKRW, netExitValueKRW: units * exitProceedsPerUnitKRW };
  });

  const investedKRW = positions.reduce((t, p) => t + p.budgetKRW, 0);
  const idleCashKRW = capital - investedKRW;

  const costs: CostBreakdown = positions.reduce(
    (t, p) => {
      const entrySlippageKRW = p.units * p.entryOpenKRW * slipRate;
      const entryFeeKRW = p.units * p.entryOpenKRW * (1 + slipRate) * feeRate;
      const exitSlippageKRW = p.units * p.exitCloseKRW * slipRate;
      const afterSlip = p.exitCloseKRW * (1 - slipRate);
      const exitFeeKRW = p.units * afterSlip * feeRate;
      const exitTaxKRW = p.units * afterSlip * taxRate;
      return {
        entrySlippageKRW: t.entrySlippageKRW + entrySlippageKRW,
        entryFeeKRW: t.entryFeeKRW + entryFeeKRW,
        exitSlippageKRW: t.exitSlippageKRW + exitSlippageKRW,
        exitFeeKRW: t.exitFeeKRW + exitFeeKRW,
        exitTaxKRW: t.exitTaxKRW + exitTaxKRW,
        totalCostKRW: 0,
      };
    },
    { entrySlippageKRW: 0, entryFeeKRW: 0, exitSlippageKRW: 0, exitFeeKRW: 0, exitTaxKRW: 0, totalCostKRW: 0 },
  );
  costs.totalCostKRW = costs.entrySlippageKRW + costs.entryFeeKRW + costs.exitSlippageKRW + costs.exitFeeKRW + costs.exitTaxKRW;

  // Marks at every held close (paper, no exit cost) except the final session, which is the actual exit (with cost).
  const equityCurve = [capital];
  for (let i = 0; i <= lastIdx; i++) {
    if (i < lastIdx) equityCurve.push(idleCashKRW + positions.reduce((t, p) => t + p.units * byTicker.get(p.ticker)!.prices[i]!.close!, 0));
    else equityCurve.push(idleCashKRW + positions.reduce((t, p) => t + p.netExitValueKRW, 0));
  }
  const finalEquityKRW = equityCurve.at(-1)!;

  const grossFinalKRW = idleCashKRW + positions.reduce((t, p) => t + (p.budgetKRW / p.entryOpenKRW) * p.exitCloseKRW, 0);
  const marketReturnPct = simpleReturnPct(input.marketBenchmark.prices[0]!.open!, input.marketBenchmark.prices[lastIdx]!.close!);
  const sectorReturnPct = simpleReturnPct(input.sectorBenchmark.prices[0]!.open!, input.sectorBenchmark.prices[lastIdx]!.close!);
  const netReturnPct = (finalEquityKRW / capital - 1) * 100;

  const forecastAccuracy: ForecastAccuracy[] = [];
  if (input.realizedEps?.length) {
    for (const e of selection.evaluations) {
      if (!e.eligible || !e.selected) continue;
      const rows = input.realizedEps.filter((r) => r.ticker === e.ticker);
      const forecastQuarters = e.bridge.quarters.map((q) => q.quarter);
      if (forecastQuarters.every((q) => rows.some((r) => r.quarter === q))) {
        const realizedNtmEpsKRW = forecastQuarters.reduce((t, q) => t + rows.find((r) => r.quarter === q)!.epsKRW, 0);
        const errorKRW = e.forecastNtmEpsKRW - realizedNtmEpsKRW;
        const denominatorOk = Math.abs(realizedNtmEpsKRW) >= config.minConsensusEpsKRW;
        forecastAccuracy.push({ ticker: e.ticker, forecastNtmEpsKRW: e.forecastNtmEpsKRW, realizedNtmEpsKRW, errorKRW,
          errorPct: denominatorOk ? errorKRW / Math.abs(realizedNtmEpsKRW) * 100 : null, reason: denominatorOk ? null : "REALIZED_EPS_NEAR_ZERO" });
      }
    }
  }

  return {
    ...metadata,
    status: "completed",
    decisionAt: input.decisionAt,
    configDigest: digest,
    entryOpenAt: sessions[0]!.openAt,
    exitCloseAt: sessions[lastIdx]!.closeAt,
    initialCapitalKRW: capital,
    idleCashKRW,
    positions,
    costs,
    equityCurve,
    finalEquityKRW,
    grossReturnPct: (grossFinalKRW / capital - 1) * 100,
    netReturnPct,
    marketReturnPct,
    sectorReturnPct,
    excessReturnVsMarketPct: netReturnPct - marketReturnPct,
    excessReturnVsSectorPct: netReturnPct - sectorReturnPct,
    maxDrawdownPct: maxDrawdownPct(equityCurve),
    turnover: {
      buyNotionalKRW: positions.reduce((n, p) => n + p.units * p.entryOpenKRW * (1 + slipRate), 0),
      sellNotionalKRW: positions.reduce((n, p) => n + p.units * p.exitCloseKRW * (1 - slipRate), 0),
      totalNotionalToInitialCapital: positions.reduce((n, p) => n + p.units * (p.entryOpenKRW * (1 + slipRate) + p.exitCloseKRW * (1 - slipRate)), 0) / capital,
    },
    cashWeightedSectorReturnPct: investedKRW / capital * sectorReturnPct,
    excessReturnVsCashWeightedSectorPct: netReturnPct - investedKRW / capital * sectorReturnPct,
    evidenceModes,
    forecastAccuracy,
    selection,
    notes: [
      "Normalized fractional-unit simulation using total-return-adjusted prices: dividends are already included, not added again. Slippage is an approximation.",
      "This is a synthetic example or retrospective research, never independently verified forward strategy performance.",
      "Benchmark returns are normalized total returns over the same entry-open-to-exit-close horizon and include no strategy trading costs.",
      "Single non-overlapping cohort: no annualized Sharpe/CAGR is computed from one short holding window.",
      SECTOR_BENCHMARK_NOTE,
    ],
  };
}
