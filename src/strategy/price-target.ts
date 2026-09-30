import type { DailyClose, QuarterlyActual } from "../collection/types.js";
import type { ForecastBridge } from "./earnings.js";

// Next-quarter fair price by holding the market's P/E constant ("PER 유지"):
//   base quarter B = the quarter just before the forecast quarter T
//   impliedPer     = average daily close in B / trailing-four-quarter EPS ending at B (reported)
//   fairPrice(T)   = impliedPer x trailing-four-quarter EPS ending at T (forecast T + reported B, B-1, B-2)
// The multiple is what the market actually paid during B; only the earnings change moves the price. It is a
// reference level, not a trading signal, and it never invents a missing quarter: any gap makes it unavailable.

export type PriceTargetReason = { code: string; message: string };

export type NextQuarterPrice = {
  status: "available" | "unavailable";
  method: "per_hold";
  targetQuarter: string | null;
  baseQuarter: string | null;
  base: { averageCloseKRW: number; tradingDays: number; firstDate: string; lastDate: string } | null;
  baseTtmEpsKRW: number | null;
  impliedPer: number | null;
  targetTtmEpsKRW: number | null;
  ttmComponents: { quarter: string; epsKRW: number; kind: "actual" | "forecast" }[];
  fairPriceKRW: number | null;
  changeVsBaseAveragePct: number | null;
  latestClose: { closeKRW: number; date: string; changeToFairPct: number } | null;
  reasons: PriceTargetReason[];
  notes: string[];
  sources: string[];
};

const MIN_BASE_SESSIONS = 40; // a KRX quarter has ~60 sessions
const EDGE_TOLERANCE_DAYS = 10; // first/last session must sit near the quarter's edges (holidays, listing gaps)

export const shiftQuarter = (q: string, n: number): string => {
  const [y, k] = [Number(q.slice(0, 4)), Number(q.slice(5))];
  const i = y * 4 + (k - 1) + n;
  return `${Math.floor(i / 4)}Q${(i % 4) + 1}`;
};

export const quarterBounds = (q: string): { start: string; end: string } => {
  const y = Number(q.slice(0, 4));
  const k = Number(q.slice(5));
  const start = new Date(Date.UTC(y, (k - 1) * 3, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(y, k * 3, 0)).toISOString().slice(0, 10);
  return { start, end };
};

const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

export function computeNextQuarterPrice(input: {
  bridge: ForecastBridge | null;
  quarterlyActuals: QuarterlyActual[];
  dailyCloses: DailyClose[];
}): NextQuarterPrice {
  const reasons: PriceTargetReason[] = [];
  const out: NextQuarterPrice = {
    status: "unavailable", method: "per_hold", targetQuarter: null, baseQuarter: null, base: null, baseTtmEpsKRW: null, impliedPer: null,
    targetTtmEpsKRW: null, ttmComponents: [], fairPriceKRW: null, changeVsBaseAveragePct: null, latestClose: null, reasons,
    notes: [
      "PER 유지 방식: 직전 분기에 시장이 실제로 매긴 PER(평균 종가 ÷ 최근 4분기 EPS)을 그대로 두고, 예측 분기를 포함한 최근 4분기 EPS 변화만 가격에 반영한 참고 가격입니다. 매매 신호나 목표가 보장이 아닙니다.",
      "실제 EPS는 네이버 분기 실적 표(연결/기본·희석 기준 미표시)이고, 예측 분기 EPS는 자체 추정(연결, 보통주 희석)이라 기준 차이가 있을 수 있습니다.",
    ],
    sources: [],
  };

  const forecast = input.bridge?.quarters.length === 1 ? input.bridge.quarters[0]! : null;
  if (!forecast) {
    reasons.push({ code: "NO_FORECAST", message: "검증된 한 분기 실적 추정(EPS)이 없어 다음 분기 가격을 계산할 수 없습니다." });
    return out;
  }
  const T = forecast.quarter;
  const B = shiftQuarter(T, -1);
  out.targetQuarter = T;
  out.baseQuarter = B;

  // 1. Average close over the base quarter, only when the sessions actually span it.
  const { start, end } = quarterBounds(B);
  const inB = input.dailyCloses.filter((d) => d.date >= start && d.date <= end).sort((a, b) => a.date.localeCompare(b.date));
  const first = inB[0];
  const last = inB[inB.length - 1];
  if (!first || !last || inB.length < MIN_BASE_SESSIONS || days(start, first.date) > EDGE_TOLERANCE_DAYS || days(last.date, end) > EDGE_TOLERANCE_DAYS) {
    reasons.push({ code: "BASE_PRICES_INCOMPLETE", message: `${B} 일별 종가가 분기 전체를 덮지 않습니다(${inB.length}거래일${first ? `, ${first.date}~${last!.date}` : ""}). 과거 기준일 분석이거나 시세 수집이 실패했을 수 있습니다.` });
  } else {
    out.base = { averageCloseKRW: round(inB.reduce((s, d) => s + d.closeKRW, 0) / inB.length, 2), tradingDays: inB.length, firstDate: first.date, lastDate: last.date };
  }

  // 2. Reported EPS for B-3..B (base TTM) -- B-2..B are reused in the target TTM.
  const actual = new Map(input.quarterlyActuals.map((a) => [a.quarter, a]));
  const needed = [3, 2, 1, 0].map((k) => shiftQuarter(B, -k));
  const missing = needed.filter((q) => !actual.has(q));
  if (missing.length) reasons.push({ code: "ACTUAL_EPS_MISSING", message: `실제 분기 EPS가 없습니다: ${missing.join(", ")} (네이버 분기 실적 표는 현재 기준일에만 수집됩니다).` });
  if (reasons.length) return out;

  const eps = needed.map((q) => actual.get(q)!.epsKRW);
  const baseTtm = eps.reduce((s, v) => s + v, 0);
  const targetTtm = eps.slice(1).reduce((s, v) => s + v, 0) + forecast.epsKRW;
  out.baseTtmEpsKRW = round(baseTtm, 2);
  out.targetTtmEpsKRW = round(targetTtm, 2);
  out.ttmComponents = [
    ...needed.slice(1).map((q) => ({ quarter: q, epsKRW: actual.get(q)!.epsKRW, kind: "actual" as const })),
    { quarter: T, epsKRW: round(forecast.epsKRW, 2), kind: "forecast" as const },
  ];
  out.sources = [...new Set(needed.map((q) => actual.get(q)!.sourceUrl))];
  if (baseTtm <= 0) {
    reasons.push({ code: "NON_POSITIVE_BASE_EPS", message: `${B}까지 최근 4분기 EPS 합이 ${out.baseTtmEpsKRW}원으로 0 이하라 PER이 의미가 없습니다.` });
    return out;
  }
  if (targetTtm <= 0) {
    reasons.push({ code: "NON_POSITIVE_TARGET_EPS", message: `${T}까지 최근 4분기 EPS 합(예측 포함)이 ${out.targetTtmEpsKRW}원으로 0 이하라 PER 유지 가격을 계산할 수 없습니다.` });
    return out;
  }

  const per = out.base!.averageCloseKRW / baseTtm;
  const fair = per * targetTtm;
  out.impliedPer = round(per, 2);
  out.fairPriceKRW = Math.round(fair);
  out.changeVsBaseAveragePct = round((fair / out.base!.averageCloseKRW - 1) * 100, 2);
  const latest = [...input.dailyCloses].sort((a, b) => b.date.localeCompare(a.date))[0];
  if (latest) out.latestClose = { closeKRW: latest.closeKRW, date: latest.date, changeToFairPct: round((fair / latest.closeKRW - 1) * 100, 2) };
  out.status = "available";
  return out;
}
