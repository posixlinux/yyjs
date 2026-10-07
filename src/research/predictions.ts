import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { QuarterlyActual } from "../collection/types.js";
import type { Analysis } from "../model/model.js";
import type { AutoStrategyResult } from "../strategy/auto.js";

// Prediction log: one JSON line per finished public analysis, so every recommendation can be scored once the target
// quarter's results are published (scripts/score-predictions.ts). Append-only; nothing reads it back at request time.

export const PREDICTION_SCHEMA_VERSION = 1;

type ScenarioPrediction = {
  scenario: string;
  quarterlyEpsKRW: number | null;
  targetPriceKRW: number | null;
  upsidePct: number | null;
  peMultiple: number;
};

export type PredictionRecord = {
  schemaVersion: number;
  jobId: string;
  recordedAt: string;
  ticker: string;
  companyName: string | null;
  asOf: string;
  modelVersion: string | null;
  /** Price the recommendation was made against (KRW) and its trade date. */
  quote: { priceKRW: number; asOf: string } | null;
  /** Product-market valuation (null when no price was produced). */
  valuation: {
    targetQuarter: string;
    grade: string | null;
    epsBasis: string | null;
    scenarios: ScenarioPrediction[];
  } | null;
  /** The automatic one-quarter earnings estimate (strategyAuto), when one was produced. */
  quarterEstimate: {
    quarter: string;
    epsKRW: number;
    revenueKRW: number;
    operatingProfitKRW: number;
    fairPriceKRW: number | null;
    status: string;
  } | null;
  /** Naver consensus for the same quarters, as observed at analysis time (reference for scoring). */
  consensus: { quarter: string; epsKRW: number | null; operatingProfitKRW: number | null; revenueKRW: number | null }[];
  quality: unknown;
  warnings: string[];
};

export function buildPredictionRecord(p: {
  jobId: string;
  recordedAt: string;
  ticker: string;
  asOf: string;
  analysis: Analysis | null;
  grade: string | null;
  strategyAuto: AutoStrategyResult;
  quarterlyConsensus: { quarter: string; epsKRW: number | null; operatingProfitKRW: number | null; revenueKRW: number | null }[];
  quality: unknown;
  warnings: string[];
}): PredictionRecord | null {
  const a = p.analysis;
  const bridgeQ = p.strategyAuto.bridge?.quarters.length === 1 ? p.strategyAuto.bridge.quarters[0]! : null;
  if (!a && !bridgeQ) return null; // nothing that could be scored later
  const quarters = new Set([a?.targetQuarter, bridgeQ?.quarter].filter(Boolean));
  return {
    schemaVersion: PREDICTION_SCHEMA_VERSION,
    jobId: p.jobId,
    recordedAt: p.recordedAt,
    ticker: p.ticker,
    companyName: a?.companyName ?? null,
    asOf: p.asOf,
    modelVersion: a?.modelVersion ?? null,
    quote: a ? { priceKRW: a.facts.quote.priceKRW, asOf: a.facts.quote.asOf } : null,
    valuation: a && {
      targetQuarter: a.targetQuarter,
      grade: p.grade,
      epsBasis: (() => {
        const v = a.scenarios.find((s) => s.valuation.status === "available")?.valuation;
        return v && v.status === "available" ? v.epsBasis : null;
      })(),
      scenarios: a.scenarios.map((s) => ({
        scenario: s.scenario,
        quarterlyEpsKRW: s.valuation.status === "available" ? s.valuation.quarterlyEpsKRW : null,
        targetPriceKRW: s.valuation.status === "available" ? s.valuation.targetPriceKRW : null,
        upsidePct: s.valuation.status === "available" ? s.valuation.upsidePct : null,
        peMultiple: a.assumptions.peMultiple[s.scenario],
      })),
    },
    quarterEstimate: bridgeQ && {
      quarter: bridgeQ.quarter,
      epsKRW: bridgeQ.epsKRW,
      revenueKRW: bridgeQ.revenueKRW,
      operatingProfitKRW: bridgeQ.operatingProfitKRW,
      fairPriceKRW: p.strategyAuto.nextQuarterPrice?.fairPriceKRW ?? null,
      status: p.strategyAuto.status,
    },
    consensus: p.quarterlyConsensus
      .filter((c) => quarters.has(c.quarter))
      .map((c) => ({ quarter: c.quarter, epsKRW: c.epsKRW, operatingProfitKRW: c.operatingProfitKRW, revenueKRW: c.revenueKRW })),
    quality: p.quality,
    warnings: p.warnings,
  };
}

/** Appends records as JSON lines to `<dir>/<name>` and reads them back (a torn last line is skipped). */
export function fileRecorder<T = PredictionRecord>(dir: string, name = "predictions.jsonl") {
  const file = path.join(dir, name);
  return {
    file,
    async record(r: T): Promise<void> {
      await mkdir(dir, { recursive: true });
      await appendFile(file, `${JSON.stringify(r)}\n`);
    },
    async readAll(): Promise<T[]> {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        return [];
      }
      return text.split("\n").filter((l) => l.trim()).flatMap((l) => {
        try {
          return [JSON.parse(l) as T];
        } catch {
          return []; // a torn last line from a crash is skipped, not fatal
        }
      });
    },
  };
}

// ---- scoring ------------------------------------------------------------------------------------------------------

export type PredictionScore = {
  jobId: string;
  ticker: string;
  asOf: string;
  quarter: string;
  status: "scored" | "pending";
  actualEpsKRW: number | null;
  /** Product-market valuation: base scenario quarterly EPS vs actual, and whether the actual fell in bear..bull. */
  valuation: { baseEpsKRW: number; errorPct: number | null; withinScenarioRange: boolean | null } | null;
  /** strategyAuto one-quarter estimate vs actual, next to the consensus error at the same time. */
  quarterEstimate: { epsKRW: number; errorPct: number | null; consensusEpsKRW: number | null; consensusErrorPct: number | null; beatConsensusError: boolean | null } | null;
  /** Price move from the recommendation quote to `latestClose`, and whether its sign matched the base upside. */
  price: { fromKRW: number; toKRW: number; toDate: string; changePct: number; baseUpsidePct: number | null; directionHit: boolean | null } | null;
};

// Error relative to |actual|; null when the actual is too close to zero for a ratio to mean anything.
const relErr = (pred: number, actual: number) => (Math.abs(actual) < 1e-9 ? null : ((pred - actual) / Math.abs(actual)) * 100);

/** Scores one record against reported quarterly EPS and a later close. Pure: the CLI supplies the data. */
export function scorePrediction(r: PredictionRecord, actuals: QuarterlyActual[], latestClose: { date: string; closeKRW: number } | null): PredictionScore[] {
  const out: PredictionScore[] = [];
  const actual = (q: string) => actuals.find((x) => x.quarter === q)?.epsKRW ?? null;
  const price = (baseUpsidePct: number | null): PredictionScore["price"] => {
    if (!r.quote || !latestClose || latestClose.date <= r.quote.asOf) return null;
    const changePct = (latestClose.closeKRW / r.quote.priceKRW - 1) * 100;
    return { fromKRW: r.quote.priceKRW, toKRW: latestClose.closeKRW, toDate: latestClose.date, changePct, baseUpsidePct, directionHit: baseUpsidePct === null || baseUpsidePct === 0 ? null : Math.sign(changePct) === Math.sign(baseUpsidePct) };
  };
  const base = r.valuation?.scenarios.find((s) => s.scenario === "base");
  const quarters = [...new Set([r.valuation?.targetQuarter, r.quarterEstimate?.quarter].filter((q): q is string => !!q))];
  for (const q of quarters) {
    const act = actual(q);
    const v = r.valuation && r.valuation.targetQuarter === q && base?.quarterlyEpsKRW != null ? r.valuation : null;
    const eps = v ? v.scenarios.map((s) => s.quarterlyEpsKRW).filter((x): x is number => x !== null) : [];
    const est = r.quarterEstimate?.quarter === q ? r.quarterEstimate : null;
    const cons = r.consensus.find((c) => c.quarter === q)?.epsKRW ?? null;
    const estErr = est && act !== null ? relErr(est.epsKRW, act) : null;
    const consErr = cons !== null && act !== null ? relErr(cons, act) : null;
    out.push({
      jobId: r.jobId,
      ticker: r.ticker,
      asOf: r.asOf,
      quarter: q,
      status: act === null ? "pending" : "scored",
      actualEpsKRW: act,
      valuation: v && base?.quarterlyEpsKRW != null
        ? { baseEpsKRW: base.quarterlyEpsKRW, errorPct: act === null ? null : relErr(base.quarterlyEpsKRW, act), withinScenarioRange: act === null || !eps.length ? null : act >= Math.min(...eps) && act <= Math.max(...eps) }
        : null,
      quarterEstimate: est && {
        epsKRW: est.epsKRW,
        errorPct: estErr,
        consensusEpsKRW: cons,
        consensusErrorPct: consErr,
        beatConsensusError: estErr === null || consErr === null ? null : Math.abs(estErr) < Math.abs(consErr),
      },
      price: price(v ? base?.upsidePct ?? null : null),
    });
  }
  return out;
}

/** Aggregate hit rates over scored rows (rows still pending are counted, not scored). */
export function summarizeScores(rows: PredictionScore[]) {
  const scored = rows.filter((r) => r.status === "scored");
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const share = (xs: (boolean | null | undefined)[]) => {
    const b = xs.filter((x): x is boolean => typeof x === "boolean");
    return b.length ? { hits: b.filter(Boolean).length, of: b.length, rate: b.filter(Boolean).length / b.length } : null;
  };
  const absErr = (xs: (number | null | undefined)[]) => mean(xs.filter((x): x is number => typeof x === "number").map(Math.abs));
  return {
    rows: rows.length,
    scored: scored.length,
    pending: rows.length - scored.length,
    valuation: {
      meanAbsEpsErrorPct: absErr(scored.map((r) => r.valuation?.errorPct)),
      actualWithinScenarioRange: share(scored.map((r) => r.valuation?.withinScenarioRange)),
    },
    quarterEstimate: {
      meanAbsEpsErrorPct: absErr(scored.map((r) => r.quarterEstimate?.errorPct)),
      consensusMeanAbsEpsErrorPct: absErr(scored.map((r) => r.quarterEstimate?.consensusErrorPct)),
      moreAccurateThanConsensus: share(scored.map((r) => r.quarterEstimate?.beatConsensusError)),
    },
    priceDirectionHit: share(rows.map((r) => r.price?.directionHit)),
  };
}
