import type { Bar } from "./history.js";

// Point-in-time features: the feature vector for day t reads bars[0..t] only (and index bars dated <= t), so a
// walk-forward backtest never sees the future. A value that cannot be computed is NaN and is imputed by the model.

export const FEATURE_NAMES = [
  "ret1", "ret2", "ret3", "ret5", "ret10", "ret20", "ret60",
  "vol5", "vol20", "volRatio", "z1", "z5",
  "ma5Gap", "ma20Gap", "ma60Gap", "rsi14",
  "range1", "closeLoc", "gap1", "volume1", "volume5",
  "idxRet1", "idxRet5", "idxVol20", "excess1", "excess5", "beta60",
  "high120Gap", "low120Gap", "downStreak", "upStreak",
  "idxRet20", "idxRet60", "idxMa60Gap",
  "fxRet1", "fxRet5", "fxRet20",
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

export const MIN_HISTORY = 61; // sessions needed before the first full feature vector (ret60, ma60)

const ln = Math.log;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const std = (xs: number[]) => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

/** Daily log returns aligned with bars (r[0] = NaN). */
export const logReturns = (bars: { close: number }[]): number[] => bars.map((b, i) => (i === 0 ? NaN : ln(b.close / bars[i - 1]!.close)));

/** Index closes aligned to the stock's dates: the latest index close on or before each date (NaN before any). */
export function alignIndex(bars: Bar[], index: Bar[]): number[] {
  const out: number[] = [];
  let j = -1;
  for (const b of bars) {
    while (j + 1 < index.length && index[j + 1]!.date <= b.date) j++;
    out.push(j >= 0 ? index[j]!.close : NaN);
  }
  return out;
}

export type FeatureContext = { bars: Bar[]; ret: number[]; idx: number[]; idxRet: number[]; fx: number[] };

/**
 * USD/KRW aligned to the stock's dates with a one-day lag: the ECB reference rate for day d is published around
 * 16:00 CET (after the KRX close), so at the close of d only rates dated before d are known.
 */
export function alignLagged(bars: Bar[], series: Bar[]): number[] {
  const out: number[] = [];
  let j = -1;
  for (const b of bars) {
    while (j + 1 < series.length && series[j + 1]!.date < b.date) j++;
    out.push(j >= 0 ? series[j]!.close : NaN);
  }
  return out;
}

export function context(bars: Bar[], index: Bar[], fx: Bar[] = []): FeatureContext {
  const idx = alignIndex(bars, index);
  const idxRet = idx.map((v, i) => (i === 0 || !(v > 0) || !(idx[i - 1]! > 0) ? NaN : ln(v / idx[i - 1]!)));
  return { bars, ret: logReturns(bars), idx, idxRet, fx: alignLagged(bars, fx) };
}

const window = (xs: number[], t: number, n: number) => xs.slice(Math.max(0, t - n + 1), t + 1).filter((x) => Number.isFinite(x));

export function features(c: FeatureContext, t: number): number[] {
  const { bars, ret, idx, idxRet, fx } = c;
  const close = bars[t]!.close;
  const back = (n: number) => (t - n >= 0 ? ln(close / bars[t - n]!.close) : NaN);
  const ma = (n: number) => (t - n + 1 >= 0 ? mean(bars.slice(t - n + 1, t + 1).map((b) => b.close)) : NaN);
  const vol5 = std(window(ret, t, 5));
  const vol20 = std(window(ret, t, 20));

  let gain = 0, loss = 0, k = 0;
  for (let i = Math.max(1, t - 13); i <= t; i++, k++) {
    const r = ret[i]!;
    if (r > 0) gain += r;
    else loss -= r;
  }
  const rsi = k >= 14 ? (gain + loss > 0 ? gain / (gain + loss) - 0.5 : 0) : NaN;

  const b = bars[t]!;
  const range1 = b.high !== null && b.low !== null ? (b.high - b.low) / close : NaN;
  const closeLoc = b.high !== null && b.low !== null && b.high > b.low ? ((close - b.low) - (b.high - close)) / (b.high - b.low) : NaN;
  const gap1 = b.open !== null && t > 0 ? ln(b.open / bars[t - 1]!.close) : NaN;
  const vols = bars.slice(Math.max(0, t - 19), t + 1).map((x) => x.volume).filter((v): v is number => v !== null && v > 0);
  const avgVol = vols.length >= 10 ? mean(vols) : NaN;
  const volume1 = b.volume !== null && b.volume > 0 && avgVol > 0 ? ln(b.volume / avgVol) : NaN;
  const v5 = bars.slice(Math.max(0, t - 4), t + 1).map((x) => x.volume).filter((v): v is number => v !== null && v > 0);
  const volume5 = v5.length >= 3 && avgVol > 0 ? ln(mean(v5) / avgVol) : NaN;

  const idxBack = (n: number) => (t - n >= 0 && idx[t]! > 0 && idx[t - n]! > 0 ? ln(idx[t]! / idx[t - n]!) : NaN);
  const idxVol20 = std(window(idxRet, t, 20));
  // 60-session beta of the stock on its index.
  let beta60 = NaN;
  {
    const xs: number[] = [], ys: number[] = [];
    for (let i = Math.max(1, t - 59); i <= t; i++) if (Number.isFinite(ret[i]!) && Number.isFinite(idxRet[i]!)) (xs.push(idxRet[i]!), ys.push(ret[i]!));
    if (xs.length >= 30) {
      const mx = mean(xs), my = mean(ys);
      const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0);
      const vx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
      beta60 = vx > 0 ? cov / vx : NaN;
    }
  }
  const hi = Math.max(...bars.slice(Math.max(0, t - 119), t + 1).map((x) => x.high ?? x.close));
  const lo = Math.min(...bars.slice(Math.max(0, t - 119), t + 1).map((x) => x.low ?? x.close));
  let down = 0, up = 0;
  for (let i = t; i > 0 && ret[i]! < 0; i--) down++;
  for (let i = t; i > 0 && ret[i]! > 0; i--) up++;

  const r1 = back(1), r5 = back(5);
  const i1 = idxBack(1), i5 = idxBack(5);
  return [
    r1, back(2), back(3), r5, back(10), back(20), back(60),
    vol5, vol20, vol5 / vol20, r1 / vol20, r5 / (vol20 * Math.sqrt(5)),
    ma(5) > 0 ? close / ma(5) - 1 : NaN, ma(20) > 0 ? close / ma(20) - 1 : NaN, ma(60) > 0 ? close / ma(60) - 1 : NaN, rsi,
    range1, closeLoc, gap1, volume1, volume5,
    i1, i5, idxVol20, r1 - (Number.isFinite(beta60) ? beta60 : 1) * i1, r5 - (Number.isFinite(beta60) ? beta60 : 1) * i5, beta60,
    ln(close / hi), ln(close / lo), Math.min(down, 10), Math.min(up, 10),
    idxBack(20), idxBack(60), t >= 59 && idx[t]! > 0 ? (() => {
      const w = idx.slice(t - 59, t + 1).filter((v) => v > 0);
      return w.length >= 50 ? idx[t]! / mean(w) - 1 : NaN;
    })() : NaN,
    fxBack(fx, t, 1), fxBack(fx, t, 5), fxBack(fx, t, 20),
  ];
}

const fxBack = (fx: number[], t: number, n: number) => (t - n >= 0 && fx[t]! > 0 && fx[t - n]! > 0 ? ln(fx[t]! / fx[t - n]!) : NaN);

/** Forward log return over h sessions from the close of day t (NaN when the future is not known yet). */
export const forwardReturn = (bars: { close: number }[], t: number, h: number): number => (t + h < bars.length ? ln(bars[t + h]!.close / bars[t]!.close) : NaN);
