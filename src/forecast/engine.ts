import { context, features, FEATURE_NAMES, forwardReturn, MIN_HISTORY } from "./features.js";
import type { Bar } from "./history.js";
import { applyPlatt, fitGbm, fitLogistic, fitPlatt, fitRidge, fitScaler, gbmProb, linear, quantile, sigmoid, transform, type Gbm, type Linear, type Scaler } from "./model.js";

// Short-term (1..3 session) direction and return forecast with an honest walk-forward backtest. Every prediction in
// the backtest is made with a model trained only on samples whose outcome was already known at that date; the final
// forecast is calibrated on those out-of-sample predictions, so a model without real skill reports probabilities
// near the base rate instead of confident guesses.

export const HORIZONS = [1, 2, 3] as const;
/** Sessions a stock needs before it can be forecast at all. */
export const MIN_HISTORY_FOR = MIN_HISTORY + 1;
export type Horizon = (typeof HORIZONS)[number];

/** `fx`: USD/KRW reference rates by date (optional; features stay NaN without it). */
export type Series = { ticker: string; bars: Bar[]; index: Bar[]; fx?: Bar[] };

export type EngineOptions = {
  /** Retrain every `step` test dates. */
  step: number;
  /** Minimum training samples before the first out-of-sample prediction. */
  minTrain: number;
  /** Most recent training samples kept (recency window). */
  maxTrain: number;
  /** Candidate L2 strengths per training sample; each refit picks one on its own latest 20% (time-ordered). */
  lambdaGrid: number[];
  /** Half-life in trading dates of the training-sample weights (recent sessions count more); 0 = equal weights. */
  halfLife: number;
  /** Also train gradient-boosted trees in the first stage (the stacker weighs them against the linear model). */
  gbm: boolean;
};

export const DEFAULT_OPTIONS: EngineOptions = { step: 20, minTrain: 250, maxTrain: 6000, lambdaGrid: [1], gbm: true, halfLife: 120 };

type Sample = { ticker: string; date: string; x: number[]; fwd: number[]; endDate: (string | null)[] };

// Cross-sectional and calendar features appended to the per-stock ones: the pooled stocks' average move that day
// (breadth beyond the index), the stock's move relative to it, and weekday/month-turn effects. All are known at t.
export const CROSS_NAMES = ["peerRet1", "peerRet5", "relRet1", "relRet5", "peerUpShare", "monday", "friday", "monthEnd", "monthStart"] as const;
const I_RET1 = FEATURE_NAMES.indexOf("ret1"), I_RET5 = FEATURE_NAMES.indexOf("ret5");

function crossRow(x: number[], date: string, peers: { ret1: number; ret5: number; up: number } | undefined): number[] {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const dom = Number(date.slice(8, 10));
  return [
    peers?.ret1 ?? NaN, peers?.ret5 ?? NaN,
    peers ? x[I_RET1]! - peers.ret1 : NaN, peers ? x[I_RET5]! - peers.ret5 : NaN,
    peers?.up ?? NaN,
    dow === 1 ? 1 : 0, dow === 5 ? 1 : 0, dom >= 26 ? 1 : 0, dom <= 3 ? 1 : 0,
  ];
}

/** Per-date average of the pooled stocks' 1- and 5-session returns and share of rising stocks (>= 3 stocks). */
function peerStats(rows: { date: string; x: number[] }[]) {
  const acc = new Map<string, { r1: number; r5: number; up: number; n: number }>();
  for (const { date, x } of rows) {
    if (!Number.isFinite(x[I_RET1]!) || !Number.isFinite(x[I_RET5]!)) continue;
    const a = acc.get(date) ?? { r1: 0, r5: 0, up: 0, n: 0 };
    a.r1 += x[I_RET1]!;
    a.r5 += x[I_RET5]!;
    a.up += x[I_RET1]! > 0 ? 1 : 0;
    a.n++;
    acc.set(date, a);
  }
  const out = new Map<string, { ret1: number; ret5: number; up: number }>();
  for (const [d, a] of acc) if (a.n >= 3) out.set(d, { ret1: a.r1 / a.n, ret5: a.r5 / a.n, up: a.up / a.n });
  return out;
}

/** Feature rows for every session with enough history; `fwd[h-1]` is NaN while the outcome is unknown. */
export function buildSamples(series: Series[]): Sample[] {
  const out: Sample[] = [];
  for (const s of series) {
    const ctx = context(s.bars, s.index, s.fx);
    for (let t = MIN_HISTORY - 1; t < s.bars.length; t++) {
      out.push({
        ticker: s.ticker,
        date: s.bars[t]!.date,
        x: features(ctx, t),
        fwd: HORIZONS.map((h) => forwardReturn(s.bars, t, h)),
        endDate: HORIZONS.map((h) => (t + h < s.bars.length ? s.bars[t + h]!.date : null)),
      });
    }
  }
  const peers = peerStats(out);
  for (const s of out) s.x = [...s.x, ...crossRow(s.x, s.date, peers.get(s.date))];
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));
}

// Returns are modelled in units of the stock's own recent volatility (vol20 x sqrt(h)): pooled stocks then share one
// scale, the ridge is not dominated by the most volatile names, and ranges come out stock-specific.
const I_VOL20 = FEATURE_NAMES.indexOf("vol20");
export const volScale = (x: number[], h: number) => {
  const v = x[I_VOL20]!;
  return (Number.isFinite(v) ? Math.max(v, 0.003) : 0.02) * Math.sqrt(h);
};

/**
 * Exponential recency weights by trading date, normalized to mean 1. The half-life is stretched when needed so the
 * effective sample size stays >= MIN_ESS rows (geometric weights give about 2.885 x half-life dates' worth): a pool
 * of many stocks adapts quickly to a regime change, a single stock keeps (almost) all of its short history.
 */
const MIN_ESS = 1500;
export function recencyWeights(dates: string[], halfLife: number): number[] | undefined {
  if (!(halfLife > 0) || !dates.length) return undefined;
  const uniq = [...new Set(dates)].sort();
  const perDate = dates.length / uniq.length;
  const h = Math.max(halfLife, MIN_ESS / (2.885 * perDate));
  const age = new Map(uniq.map((d, i) => [d, uniq.length - 1 - i]));
  const raw = dates.map((d) => 0.5 ** (age.get(d)! / h));
  const m = raw.reduce((a, v) => a + v, 0) / raw.length;
  return raw.map((v) => v / m);
}

type Fitted = { scaler: Scaler; logistic: Linear; ridge: Linear; gbm: Gbm | null; baseRate: number };

function fit(train: Sample[], hi: number, o: EngineOptions): Fitted | null {
  const rows = train.filter((s) => Number.isFinite(s.fwd[hi]!) && s.fwd[hi] !== 0);
  if (rows.length < Math.min(o.minTrain, 60)) return null;
  const X0 = rows.map((s) => s.x);
  // Exponential recency weights by trading date (normalized to mean 1, so lambda keeps its meaning).
  const w = recencyWeights(rows.map((s) => s.date), o.halfLife);
  const scaler = fitScaler(X0);
  const X = X0.map((x) => transform(scaler, x));
  const y: number[] = rows.map((s) => (s.fwd[hi]! > 0 ? 1 : 0));
  // Returns are winsorized for the ridge fit so a single limit-up/limit-down day does not set the slope.
  const r = rows.map((s) => s.fwd[hi]! / volScale(s.x, hi + 1));
  const lo = quantile(r, 0.01), up = quantile(r, 0.99);
  const rw = r.map((v) => Math.max(lo, Math.min(up, v)));
  // Regularization chosen on the most recent 20% of the training window (fit on the older 80%), then refit on all:
  // with weak signals and correlated features, too little shrinkage overfits and too much discards the signal.
  const cut = Math.floor(rows.length * 0.8);
  const logLoss = (m: Linear, from: number) => {
    let s = 0;
    for (let i = from; i < X.length; i++) {
      const p = Math.min(1 - 1e-6, Math.max(1e-6, sigmoid(linear(m, X[i]!))));
      s -= y[i]! ? Math.log(p) : Math.log(1 - p);
    }
    return s;
  };
  const mse = (m: Linear, from: number) => {
    let s = 0;
    for (let i = from; i < X.length; i++) s += (linear(m, X[i]!) - rw[i]!) ** 2;
    return s;
  };
  let bestL = o.lambdaGrid[0]!, bestR = o.lambdaGrid[0]!, lossL = Infinity, lossR = Infinity;
  if (o.lambdaGrid.length === 1) bestL = bestR = o.lambdaGrid[0]!;
  else if (rows.length - cut >= 30) {
    const Xa = X.slice(0, cut);
    for (const lam of o.lambdaGrid) {
      const l = logLoss(fitLogistic(Xa, y.slice(0, cut), lam * cut, 12, w?.slice(0, cut)), cut);
      if (l < lossL) (lossL = l), (bestL = lam);
      const m = mse(fitRidge(Xa, rw.slice(0, cut), lam * cut, w?.slice(0, cut)), cut);
      if (m < lossR) (lossR = m), (bestR = lam);
    }
  } else bestL = bestR = o.lambdaGrid.at(-1)!;
  return {
    scaler,
    logistic: fitLogistic(X, y, bestL * rows.length, 12, w),
    ridge: fitRidge(X, rw, bestR * rows.length, w),
    gbm: o.gbm ? fitGbm(X, y, { weights: w }) : null,
    baseRate: y.reduce((s, v) => s + v, 0) / y.length,
  };
}

const predict = (f: Fitted, x: number[], h: number) => {
  const z = transform(f.scaler, x);
  const p = sigmoid(linear(f.logistic, z));
  return { p, r: linear(f.ridge, z) * volScale(x, h), pg: f.gbm ? gbmProb(f.gbm, z) : p };
};

const PAST = (["ret1", "ret2", "ret3"] as const).map((n) => FEATURE_NAMES.indexOf(n));

export type OosPrediction = { ticker: string; date: string; endDate: string; scale: number; p: number; pg: number; r: number; baseRate: number; actual: number; past: number; ret1: number };

/** Walk-forward out-of-sample predictions for horizon index `hi` (0 -> 1 session). */
export function walkForward(samples: Sample[], hi: number, o: EngineOptions = DEFAULT_OPTIONS): OosPrediction[] {
  const dates = [...new Set(samples.map((s) => s.date))].sort();
  const byDate = new Map<string, Sample[]>();
  for (const s of samples) (byDate.get(s.date) ?? byDate.set(s.date, []).get(s.date)!).push(s);
  const out: OosPrediction[] = [];
  let model: Fitted | null = null;
  let sinceFit = Infinity;
  for (const d of dates) {
    if (sinceFit >= o.step) {
      // Known outcomes only: the label window must have closed on or before today's close.
      const known = samples.filter((s) => s.endDate[hi] !== null && s.endDate[hi]! <= d);
      if (known.length >= o.minTrain) {
        model = fit(known.slice(-o.maxTrain), hi, o);
        sinceFit = 0;
      }
    }
    sinceFit++;
    if (!model) continue;
    for (const s of byDate.get(d)!) {
      const actual = s.fwd[hi]!;
      if (!Number.isFinite(actual)) continue;
      const { p, pg, r } = predict(model, s.x, hi + 1);
      out.push({ ticker: s.ticker, date: d, endDate: s.endDate[hi]!, scale: volScale(s.x, hi + 1), p, pg, r, baseRate: model.baseRate, actual, past: s.x[PAST[hi]!]!, ret1: s.x[PAST[0]!]! });
    }
  }
  return out;
}

// ---- second stage: stack the model with the simple rules ---------------------------------------------------------

const logit = (p: number) => Math.log(Math.max(1e-6, p) / Math.max(1e-6, 1 - p));
/** Meta features: the model's log-odds and the signs of the last h-session and last-session moves. */
const metaX = (o: { p: number; pg: number; past: number; ret1: number }) => [logit((o.p + o.pg) / 2), Math.sign(o.past) || 0, Math.sign(o.ret1) || 0];
const metaR = (o: { r: number; past: number }) => [o.r, Number.isFinite(o.past) ? o.past : 0];

/** Below this many resolved first-stage rows the stacker is not trusted: the first-stage average is used as is. */
export const META_MIN_ROWS = 300;

export type Meta = { cls: Linear; reg: Linear; n: number };

/** Fits the stage-two models on first-stage out-of-sample rows (all of them must have known outcomes). */
export function fitMeta(rows: OosPrediction[], halfLife = 0): Meta | null {
  if (rows.length < META_MIN_ROWS) return null;
  const w = recencyWeights(rows.map((o) => o.date), halfLife);
  const y = rows.map((o) => (o.actual > 0 ? 1 : 0));
  const act = rows.map((o) => o.actual);
  const lo = quantile(act, 0.01), hi = quantile(act, 0.99);
  return {
    cls: fitLogistic(rows.map(metaX), y, 1e-3 * rows.length, 30, w),
    reg: fitRidge(rows.map(metaR), act.map((v) => Math.max(lo, Math.min(hi, v))), 1e-6 * rows.length, w),
    n: rows.length,
  };
}
export const metaPredict = (m: Meta, o: { p: number; pg: number; r: number; past: number; ret1: number }) => ({ p: sigmoid(linear(m.cls, metaX(o))), r: linear(m.reg, metaR(o)) });

/**
 * Walk-forward over the first-stage predictions: at each date the meta model is trained only on rows whose outcome
 * window had closed by then. Returns second-stage out-of-sample rows (p and r replaced).
 */
export function stack(oos: OosPrediction[], step = 20, halfLife = 0): OosPrediction[] {
  const dates = [...new Set(oos.map((o) => o.date))].sort();
  const byDate = new Map<string, OosPrediction[]>();
  for (const o of oos) (byDate.get(o.date) ?? byDate.set(o.date, []).get(o.date)!).push(o);
  const out: OosPrediction[] = [];
  let meta: Meta | null = null;
  let since = Infinity;
  for (const d of dates) {
    if (since >= step) {
      const m = fitMeta(oos.filter((o) => o.endDate <= d), halfLife);
      if (m) (meta = m), (since = 0);
    }
    since++;
    for (const o of byDate.get(d)!) out.push(meta ? { ...o, ...metaPredict(meta, o) } : { ...o, p: (o.p + o.pg) / 2 });
  }
  return out;
}

// ---- metrics ------------------------------------------------------------------------------------------------------

/** One-sided p-value that a hit rate of k/n beats `p0` (normal approximation to the binomial). */
export function pValueAbove(k: number, n: number, p0: number): number {
  if (n === 0) return 1;
  const z = (k - n * p0) / Math.sqrt(n * p0 * (1 - p0));
  return 0.5 * erfc(z / Math.SQRT2);
}
function erfc(x: number): number {
  // Abramowitz-Stegun 7.1.26 (|error| < 1.5e-7)
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return x >= 0 ? y : 2 - y;
}

export type BacktestStats = {
  horizon: number;
  n: number;
  from: string | null;
  to: string | null;
  accuracy: number | null;
  /** Baselines on the same predictions: always "up", and "the last h sessions' direction continues". */
  alwaysUpAccuracy: number | null;
  momentumAccuracy: number | null;
  pValueVsCoin: number | null;
  /** vs the better of "always up" / "always down" (the historical base rate). */
  pValueVsClimatology: number | null;
  /** vs the best of coin, base rate and momentum. */
  pValueVsBestBaseline: number | null;
  brier: number | null;
  brierBaseRate: number | null;
  meanAbsErrorPct: number | null;
  zeroForecastMaePct: number | null;
  /** Mean realized return when the model said up minus when it said down (percentage points). */
  upDownSpreadPct: number | null;
  /** Accuracy on the 30% most confident predictions. */
  confidentAccuracy: number | null;
  confidentN: number;
  /**
   * Share of realized returns inside the 80% range when each range is built only from errors resolved before its
   * date (null until set by forecastMany). Close to 0.8 means the ranges are honest.
   */
  range80Coverage: number | null;
  /** Reliability table: predictions bucketed by probability of a rise, with the share that actually rose. */
  calibration: { from: number; to: number; n: number; meanPredicted: number; actualUpRate: number }[];
  edge: "detected" | "none";
};

const CAL_BINS: [number, number][] = [[0, 0.45], [0.45, 0.5], [0.5, 0.55], [0.55, 1]];

export function backtestStats(oos: OosPrediction[], horizon: number): BacktestStats {
  const n = oos.length;
  const pct = (v: number) => (Math.exp(v) - 1) * 100;
  if (!n)
    return { horizon, n: 0, from: null, to: null, accuracy: null, alwaysUpAccuracy: null, momentumAccuracy: null, pValueVsCoin: null, pValueVsClimatology: null, pValueVsBestBaseline: null, brier: null, brierBaseRate: null, meanAbsErrorPct: null, zeroForecastMaePct: null, upDownSpreadPct: null, confidentAccuracy: null, confidentN: 0, range80Coverage: null, calibration: [], edge: "none" };
  const up = (v: number) => v > 0;
  const hits = oos.filter((o) => (o.p > 0.5) === up(o.actual)).length;
  const ups = oos.filter((o) => up(o.actual)).length;
  const mom = oos.filter((o) => Number.isFinite(o.past) && o.past !== 0);
  const momHits = mom.filter((o) => up(o.past) === up(o.actual)).length;
  const accuracy = hits / n;
  const alwaysUp = ups / n;
  const momentum = mom.length ? momHits / mom.length : 0;
  const best = Math.max(0.5, alwaysUp, 1 - alwaysUp, momentum);
  const brier = oos.reduce((s, o) => s + (o.p - (up(o.actual) ? 1 : 0)) ** 2, 0) / n;
  const brierBase = oos.reduce((s, o) => s + (o.baseRate - (up(o.actual) ? 1 : 0)) ** 2, 0) / n;
  const mae = oos.reduce((s, o) => s + Math.abs(pct(o.r) - pct(o.actual)), 0) / n;
  const mae0 = oos.reduce((s, o) => s + Math.abs(pct(o.actual)), 0) / n;
  const saidUp = oos.filter((o) => o.p > 0.5), saidDown = oos.filter((o) => o.p <= 0.5);
  const avg = (xs: OosPrediction[]) => xs.reduce((s, o) => s + pct(o.actual), 0) / xs.length;
  const conf = [...oos].sort((a, b) => Math.abs(b.p - 0.5) - Math.abs(a.p - 0.5)).slice(0, Math.max(1, Math.floor(n * 0.3)));
  const confHits = conf.filter((o) => (o.p > 0.5) === up(o.actual)).length;
  // Overlapping h-session windows are not independent: test on n/h effective observations (conservative).
  const nEff = Math.max(1, Math.floor(n / horizon));
  const pCoin = pValueAbove((hits / n) * nEff, nEff, 0.5);
  const climate = Math.max(0.5, alwaysUp, 1 - alwaysUp);
  const pClimate = pValueAbove((hits / n) * nEff, nEff, climate);
  const pBest = pValueAbove((hits / n) * nEff, nEff, best);
  return {
    horizon,
    n,
    from: oos[0]!.date,
    to: oos.at(-1)!.date,
    accuracy,
    alwaysUpAccuracy: alwaysUp,
    momentumAccuracy: mom.length ? momentum : null,
    pValueVsCoin: pCoin,
    pValueVsClimatology: pClimate,
    pValueVsBestBaseline: pBest,
    brier,
    brierBaseRate: brierBase,
    meanAbsErrorPct: mae,
    zeroForecastMaePct: mae0,
    upDownSpreadPct: saidUp.length && saidDown.length ? avg(saidUp) - avg(saidDown) : null,
    confidentAccuracy: confHits / conf.length,
    confidentN: conf.length,
    range80Coverage: null,
    calibration: CAL_BINS.map(([from, to]) => {
      const xs = oos.filter((o) => o.p >= from && (o.p < to || to === 1));
      return { from, to, n: xs.length, meanPredicted: xs.reduce((a, o) => a + o.p, 0) / xs.length, actualUpRate: xs.filter((o) => up(o.actual)).length / xs.length };
    }).filter((b) => b.n > 0),
    // Skill must beat the coin and the always-same-direction rule significantly AND improve the probability score.
    // (Beating the simple momentum rule as well is reported via pValueVsBestBaseline, not required.)
    edge: nEff >= 100 && pClimate < 0.05 && brier < brierBase ? "detected" : "none",
  };
}

/**
 * Expected-return calibration in volatility units from resolved out-of-sample rows: the slope of realized on
 * predicted (clamped to [0, 1], which shrinks a noisy regression toward zero), its intercept, and the 10%/90%
 * residual quantiles that make the 80% range. Null with fewer than 100 rows.
 */
export function calibrateReturns(rows: OosPrediction[]): { slope: number; icpt: number; q: [number, number] } | null {
  if (rows.length < 100) return null;
  const zr = rows.map((x) => x.r / x.scale), za = rows.map((x) => x.actual / x.scale);
  const mx = zr.reduce((a, v) => a + v, 0) / zr.length, my = za.reduce((a, v) => a + v, 0) / za.length;
  const cov = zr.reduce((a, v, i) => a + (v - mx) * (za[i]! - my), 0), vx = zr.reduce((a, v) => a + (v - mx) ** 2, 0);
  const slope = vx > 0 ? Math.max(0, Math.min(1, cov / vx)) : 0;
  const icpt = my - slope * mx;
  const res = za.map((v, i) => v - (icpt + slope * zr[i]!));
  return { slope, icpt, q: [quantile(res, 0.1), quantile(res, 0.9)] };
}

/**
 * Walk-forward coverage of the 80% range: for rows dated d, the range comes from volatility-unit residuals of rows
 * whose outcome closed before d (re-estimated every `step` dates); returns the share of rows inside, per ticker.
 */
export function rangeCoverage(oos: OosPrediction[], step = 20): Map<string, { inside: number; n: number }> {
  const dates = [...new Set(oos.map((o) => o.date))].sort();
  const byDate = new Map<string, OosPrediction[]>();
  for (const o of oos) (byDate.get(o.date) ?? byDate.set(o.date, []).get(o.date)!).push(o);
  const out = new Map<string, { inside: number; n: number }>();
  let cal: ReturnType<typeof calibrateReturns> = null, since = Infinity;
  for (const d of dates) {
    if (since >= step) {
      const c = calibrateReturns(oos.filter((o) => o.endDate < d));
      if (c) (cal = c), (since = 0);
    }
    since++;
    if (!cal) continue;
    for (const o of byDate.get(d)!) {
      const c = out.get(o.ticker) ?? { inside: 0, n: 0 };
      const center = cal.icpt + cal.slope * (o.r / o.scale);
      const z = o.actual / o.scale;
      c.n++;
      if (z >= center + cal.q[0] && z <= center + cal.q[1]) c.inside++;
      out.set(o.ticker, c);
    }
  }
  return out;
}

// ---- final forecast -----------------------------------------------------------------------------------------------

export type HorizonForecast = {
  horizon: number;
  /** Trading session the forecast closes on, counted from `asOfDate` (1 = next session). */
  probabilityUp: number;
  rawProbabilityUp: number;
  direction: "up" | "down";
  /** "low" whenever the backtest found no edge: treat the direction as a coin flip. */
  confidence: "high" | "medium" | "low";
  expectedReturnPct: number;
  /** 80% range of the return from the out-of-sample residuals. */
  range80Pct: [number, number];
  expectedPriceKRW: number;
  /**
   * The backtest found an edge AND the expected move clears a round trip's cost (ROUND_TRIP_COST_PCT) in the
   * forecast direction. Everything else is information, not a trade.
   */
  actionable: boolean;
  backtest: BacktestStats;
};

/** Approximate KRX round-trip cost: two brokerage fees plus the sell-side transaction tax (percent of price). */
export const ROUND_TRIP_COST_PCT = 0.25;

export type ForecastResult = {
  ticker: string;
  asOfDate: string;
  lastCloseKRW: number;
  horizons: HorizonForecast[];
  trainedOn: { tickers: string[]; samples: number };
  featureNames: readonly string[];
  notes: string[];
};

/**
 * Trains once on the pooled series (walk-forward + stacking + calibration per horizon) and forecasts the next 1..3
 * sessions for every series in `targets` (default: all). Backtest stats are per stock; `pooled` is over every stock.
 */
export function forecastMany(series: Series[], o: EngineOptions = DEFAULT_OPTIONS, targets?: string[]): { results: ForecastResult[]; pooled: BacktestStats[] } {
  const samples = buildSamples(series);
  const want = series.filter((s) => (!targets || targets.includes(s.ticker)) && s.bars.length > MIN_HISTORY);
  const per = new Map<string, HorizonForecast[]>(want.map((s) => [s.ticker, []]));
  const pooled: BacktestStats[] = [];
  const pct = (v: number) => (Math.exp(v) - 1) * 100;
  const lastOf = new Map(want.map((s) => [s.ticker, samples.findLast((x) => x.ticker === s.ticker)!]));
  for (const [hi, h] of HORIZONS.entries()) {
    const first = walkForward(samples, hi, o);
    const oosAll = stack(first, o.step, o.halfLife);
    const coverage = rangeCoverage(oosAll, o.step);
    const covOf = (keep: (t: string) => boolean) => {
      let inside = 0, n = 0;
      for (const [t, c] of coverage) if (keep(t)) (inside += c.inside), (n += c.n);
      return n ? inside / n : null;
    };
    pooled.push({ ...backtestStats(oosAll, h), range80Coverage: covOf(() => true) });
    const model = fit(samples.filter((s) => Number.isFinite(s.fwd[hi]!)).slice(-o.maxTrain), hi, o);
    if (!model) throw new Error(`Not enough history to train the ${h}-session model`);
    const meta = fitMeta(first, o.halfLife);
    // Calibrate on every out-of-sample prediction (pooled is steadier than one stock's alone).
    const calib = oosAll.length >= 100 ? fitPlatt(oosAll.map((x) => x.p), oosAll.map((x) => (x.actual > 0 ? 1 : 0))) : null;
    const cal = calibrateReturns(oosAll);
    const slope = cal?.slope ?? 0, icpt = cal?.icpt ?? 0, qLo = cal?.q[0] ?? NaN, qHi = cal?.q[1] ?? NaN;
    for (const s of want) {
      const xNow = lastOf.get(s.ticker)!.x;
      const raw0 = predict(model, xNow, h);
      const now = { ...raw0, past: xNow[PAST[hi]!]!, ret1: xNow[PAST[0]!]! };
      const raw = meta ? metaPredict(meta, now) : { ...raw0, p: (raw0.p + raw0.pg) / 2 };
      const pUp = calib ? applyPlatt(calib, raw.p) : model.baseRate;
      const scaleNow = volScale(xNow, h);
      const exp = (icpt + slope * (raw.r / scaleNow)) * scaleNow;
      const stats = { ...backtestStats(oosAll.filter((x) => x.ticker === s.ticker), h), range80Coverage: covOf((t) => t === s.ticker) };
      // A stock with too few of its own predictions inherits the pool's verdict on whether there is an edge.
      const edge = (stats.n >= 120 ? stats : pooled[hi]!).edge === "detected";
      per.get(s.ticker)!.push({
        horizon: h,
        probabilityUp: pUp,
        rawProbabilityUp: raw.p,
        direction: pUp >= 0.5 ? "up" : "down",
        confidence: !edge ? "low" : Math.abs(pUp - 0.5) >= 0.1 ? "high" : "medium",
        expectedReturnPct: pct(exp),
        range80Pct: [pct(exp + qLo * scaleNow), pct(exp + qHi * scaleNow)],
        expectedPriceKRW: s.bars.at(-1)!.close * Math.exp(exp),
        actionable: edge && Math.abs(pct(exp)) > ROUND_TRIP_COST_PCT && (pUp >= 0.5) === exp > 0,
        backtest: stats,
      });
    }
  }
  const results = want.map((s): ForecastResult => {
    const horizons = per.get(s.ticker)!;
    const notes = [
      "단기 주가는 대부분 잡음입니다. 방향을 얼마나 믿을지는 예측값이 아니라 백테스트 적중률이 알려 줍니다.",
      "상승 확률은 워크포워드 표본 외 예측으로 보정한 값이라, 검증된 예측력이 없으면 과거 상승일 비율 근처에 머뭅니다.",
      "투자 권고가 아닙니다. 가격은 네이버 일별 종가(액면분할·배당 미조정)입니다.",
    ];
    if (horizons.every((h) => h.confidence === "low")) notes.unshift("어느 기간도 워크포워드 백테스트에서 단순 기준(동전·항상 같은 방향)을 유의하게 넘지 못했습니다. 이번 방향은 동전 던지기로 보세요.");
    return { ticker: s.ticker, asOfDate: s.bars.at(-1)!.date, lastCloseKRW: s.bars.at(-1)!.close, horizons, trainedOn: { tickers: series.map((x) => x.ticker), samples: samples.length }, featureNames: [...FEATURE_NAMES, ...CROSS_NAMES], notes };
  });
  return { results, pooled };
}

/** Fits on all known outcomes, predicts the next 1..3 sessions for `target`, and calibrates on the walk-forward. */
export function forecast(target: Series, peers: Series[] = [], o: EngineOptions = DEFAULT_OPTIONS): ForecastResult {
  if (target.bars.length <= MIN_HISTORY) throw new Error(`Need at least ${MIN_HISTORY + 1} sessions of ${target.ticker}; have ${target.bars.length}`);
  const all = [target, ...peers.filter((p) => p.ticker !== target.ticker)];
  return forecastMany(all, o, [target.ticker]).results[0]!;
}
