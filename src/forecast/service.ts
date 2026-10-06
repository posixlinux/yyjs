import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createHttp } from "../collection/http.js";
import { CollectionError } from "../collection/types.js";
import { AppError } from "../errors.js";
import type { UniverseProvider } from "../research/universe.js";
import type { ListedExchange } from "../domain/security.js";
import { DEFAULT_OPTIONS, type EngineOptions, type ForecastResult, type Series } from "./engine.js";
import { adjustCorporateActions, loadHistory, loadIndex, loadStock, loadUsdKrw, type Bar, type StockHistory } from "./history.js";
import { runEngine, runMany } from "./runner.js";

// Short-term forecast service: loads the target's history and that of liquid peers on the same exchange (pooled
// training: one stock has too few sessions for a stable model), runs the engine, caches the result for the trading
// day and appends each forecast to a JSONL log so it can be scored later (scorePending).

export type ForecastDeps = {
  fetch?: typeof fetch;
  universe?: UniverseProvider;
  /** Directory of forecasts.jsonl; unset = no log. */
  logDir?: string;
  now?: () => Date;
  options?: Partial<EngineOptions>;
  /** History depth in 60-session pages (default 12, about three years). */
  pages?: number;
};

export type ForecastLogRecord = {
  schemaVersion: 1;
  recordedAt: string;
  ticker: string;
  asOfDate: string;
  lastCloseKRW: number;
  horizons: { horizon: number; probabilityUp: number; direction: string; confidence: string; expectedReturnPct: number; range80Pct: [number, number]; backtestAccuracy: number | null; edge: string }[];
  peers: string[];
};

export type ForecastScore = {
  ticker: string;
  asOfDate: string;
  horizon: number;
  status: "scored" | "pending";
  targetDate: string | null;
  actualReturnPct: number | null;
  predictedReturnPct: number;
  probabilityUp: number;
  directionHit: boolean | null;
  withinRange80: boolean | null;
  confidence: string;
};

const MAX_PEERS = 40;

/** Stock history with splits/consolidations (moves beyond the +-30% daily limit) folded into earlier prices. */
async function loadAdjusted(http: Parameters<typeof loadStock>[0], ticker: string, pages: number): Promise<StockHistory & { adjusted: string[] }> {
  const s = await loadStock(http, ticker, { maxPages: pages });
  const { bars, adjusted } = adjustCorporateActions(s.bars);
  return { ...s, bars, adjusted };
}
const HISTORY_TTL_MS = 30 * 60_000; // daily bars change once a day; peers are shared between forecasts

export class ForecastService {
  private cache = new Map<string, { at: number; result: ForecastResult }>();
  private inflight = new Map<string, Promise<ForecastResult & { peerFailures: string[] }>>();
  private stocks = new Map<string, { at: number; value: Promise<StockHistory & { adjusted: string[] }> }>();
  private indexes = new Map<string, { at: number; value: Promise<Bar[]> }>();

  /** USD/KRW over the bars' span; [] (features stay empty) when the rate source is unreachable. */
  private async fx(http: ReturnType<ForecastService["http"]>, bars: Bar[], notes: string[]): Promise<Bar[]> {
    if (!bars.length) return [];
    const from = bars[0]!.date, to = bars.at(-1)!.date;
    try {
      return await this.cached(this.indexes, `fx|${from}|${to}`, () => loadUsdKrw(http, from, to));
    } catch {
      notes.push("원/달러 환율 이력을 받지 못해 환율 특징 없이 계산했습니다.");
      return [];
    }
  }

  private cached<T>(m: Map<string, { at: number; value: Promise<T> }>, key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = m.get(key);
    if (hit && now - hit.at < HISTORY_TTL_MS) return hit.value;
    const value = load();
    m.set(key, { at: now, value });
    value.catch(() => m.get(key)?.value === value && m.delete(key));
    if (m.size > 200) m.delete(m.keys().next().value as string);
    return value;
  }

  constructor(private deps: ForecastDeps = {}) {}

  private http(maxRequests: number) {
    return createHttp({ fetch: this.deps.fetch ?? fetch, timeoutMs: 15_000, maxBytes: 5 * 1024 * 1024, maxRequests, secrets: [] });
  }

  /** Peer tickers: explicit, else the largest common stocks on the target's exchange. */
  private async peerTickers(target: string, exchange: string, explicit: string[] | undefined, count: number): Promise<string[]> {
    if (explicit?.length) return [...new Set(explicit.filter((t) => t !== target))].slice(0, MAX_PEERS);
    if (!this.deps.universe || count <= 0) return [];
    try {
      const u = await this.deps.universe.get();
      return u.items.filter((i) => i.exchange === exchange && i.ticker !== target).slice(0, Math.min(count, MAX_PEERS)).map((i) => i.ticker);
    } catch {
      return []; // peers improve stability but are optional
    }
  }

  /** Same request in flight -> the same promise (a double click or two tabs never doubles the work). */
  run(ticker: string, opts: { peers?: string[]; peerCount?: number } = {}): Promise<ForecastResult & { peerFailures: string[] }> {
    const key = `${ticker}|${(opts.peers ?? []).join(",")}|${opts.peerCount ?? 20}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.compute(ticker, key, opts).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async compute(ticker: string, key: string, opts: { peers?: string[]; peerCount?: number }): Promise<ForecastResult & { peerFailures: string[] }> {
    const peerCount = opts.peerCount ?? 20;
    const now = (this.deps.now ?? (() => new Date()))().getTime();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < 30 * 60_000) return { ...hit.result, peerFailures: [] };

    const pages = this.deps.pages ?? 12;
    const http = this.http((2 + pages * 2) * (2 + Math.min(MAX_PEERS, opts.peers?.length ?? peerCount)));
    const stock = (t: string) => this.cached(this.stocks, `${t}|${pages}`, () => loadAdjusted(http, t, pages));
    const index = (ex: ListedExchange) => this.cached(this.indexes, `${ex}|${pages}`, () => loadIndex(http, ex, { maxPages: pages }));
    let target;
    try {
      const s = await stock(ticker);
      target = { ...s, index: await index(s.exchange), indexName: s.exchange };
    } catch (e) {
      if (e instanceof CollectionError && e.code === "not_listed") throw new AppError(422, "NOT_LISTED", e.message);
      throw new AppError(502, "HISTORY_UNAVAILABLE", `Could not load ${ticker}'s price history: ${(e as Error).message}`);
    }
    const peerFailures: string[] = [];
    const peers: Series[] = [];
    const tickers = await this.peerTickers(ticker, target.exchange, opts.peers, peerCount);
    // Bounded concurrency; a failing peer is skipped, never fatal.
    for (let i = 0; i < tickers.length; i += 4) {
      const got = await Promise.allSettled(tickers.slice(i, i + 4).map(async (t) => {
        const s = await stock(t);
        return { ticker: s.ticker, bars: s.bars, index: await index(s.exchange) };
      }));
      got.forEach((g, j) => (g.status === "fulfilled" ? peers.push(g.value) : peerFailures.push(tickers[i + j]!)));
    }
    const fxNotes: string[] = [];
    const fx = await this.fx(http, target.index.length ? target.index : target.bars, fxNotes);
    let result: ForecastResult;
    try {
      result = await runEngine({ ticker, bars: target.bars, index: target.index, fx }, peers.map((p) => ({ ...p, fx })), { ...DEFAULT_OPTIONS, ...this.deps.options });
    } catch (e) {
      throw new AppError(422, "INSUFFICIENT_HISTORY", (e as Error).message);
    }
    result.notes.push(...fxNotes);
    if (target.adjusted.length) result.notes.push(`가격제한폭(±30%)을 넘는 변동을 액면분할·병합으로 보고 이전 가격을 보정했습니다: ${target.adjusted.join(", ")}.`);
    if (target.name) result.notes.push(`${target.name} (${target.exchange}), 시장 지수 ${target.indexName} 사용.`);
    if (peerFailures.length) result.notes.push(`시세 이력을 받지 못해 제외한 동종 종목: ${peerFailures.join(", ")}.`);
    this.cache.set(key, { at: now, result });
    await this.log(result).catch(() => result.notes.push("예측 기록 파일에 저장하지 못했습니다."));
    return { ...result, peerFailures };
  }

  /**
   * "Which stocks are most likely to rise": one pooled model over the largest `count` stocks of an exchange, ranked
   * by the probability of a rise over `horizon` sessions. Low-confidence rows stay in the list, flagged.
   */
  async rank(opts: { exchange?: ListedExchange; count?: number; horizon?: 1 | 2 | 3 } = {}) {
    const exchange = opts.exchange ?? "KOSPI";
    const count = Math.min(opts.count ?? 30, MAX_PEERS);
    const horizon = opts.horizon ?? 1;
    if (!this.deps.universe) throw new AppError(503, "UNIVERSE_UNAVAILABLE", "No stock list is configured for ranking");
    let tickers: { ticker: string; name: string }[];
    try {
      tickers = (await this.deps.universe.get()).items.filter((i) => i.exchange === exchange).slice(0, count).map((i) => ({ ticker: i.ticker, name: i.name }));
    } catch {
      throw new AppError(502, "UNIVERSE_UNAVAILABLE", "Could not load the KOSPI/KOSDAQ stock list from Naver Finance");
    }
    const pages = this.deps.pages ?? 12;
    const http = this.http((2 + pages) * (count + 2));
    const index = await this.cached(this.indexes, `${exchange}|${pages}`, () => loadIndex(http, exchange, { maxPages: pages })).catch((e: Error) => {
      throw new AppError(502, "HISTORY_UNAVAILABLE", `Could not load the ${exchange} index: ${e.message}`);
    });
    const series: Series[] = [];
    const failures: string[] = [];
    for (let i = 0; i < tickers.length; i += 4) {
      const got = await Promise.allSettled(tickers.slice(i, i + 4).map((t) => this.cached(this.stocks, `${t.ticker}|${pages}`, () => loadAdjusted(http, t.ticker, pages))));
      got.forEach((g, j) => (g.status === "fulfilled" ? series.push({ ticker: g.value.ticker, bars: g.value.bars, index }) : failures.push(tickers[i + j]!.ticker)));
    }
    if (series.length < 3) throw new AppError(502, "HISTORY_UNAVAILABLE", "Too few price histories could be loaded to rank");
    const fxNotes: string[] = [];
    const fx = await this.fx(http, index, fxNotes);
    const { results, pooled } = await runMany(series.map((s) => ({ ...s, fx })), { ...DEFAULT_OPTIONS, ...this.deps.options });
    const name = new Map(tickers.map((t) => [t.ticker, t.name]));
    const rows = results
      .map((r) => {
        const h = r.horizons.find((x) => x.horizon === horizon)!;
        return { ticker: r.ticker, name: name.get(r.ticker) ?? null, asOfDate: r.asOfDate, lastCloseKRW: r.lastCloseKRW, probabilityUp: h.probabilityUp, expectedReturnPct: h.expectedReturnPct, range80Pct: h.range80Pct, confidence: h.confidence, actionable: h.actionable, backtestAccuracy: h.backtest.accuracy, backtestN: h.backtest.n };
      })
      .sort((a, b) => b.probabilityUp - a.probabilityUp || b.expectedReturnPct - a.expectedReturnPct);
    for (const r of results) await this.log(r).catch(() => undefined);
    return {
      exchange,
      horizon,
      ranked: rows,
      pooledBacktest: pooled.find((p) => p.horizon === horizon)!,
      failures,
      notes: [
        pooled.find((p) => p.horizon === horizon)!.edge === "detected"
          ? "이 종목군 전체의 워크포워드 백테스트에서 단순 기준을 유의하게 넘었습니다. 그래도 개별 종목의 신뢰도와 범위를 함께 보세요."
          : "이 종목군 전체의 워크포워드 백테스트에서 단순 기준을 유의하게 넘지 못했습니다. 순위는 동전 던지기와 크게 다르지 않을 수 있습니다.",
        ...fxNotes,
        "투자 권고가 아닙니다.",
      ],
    };
  }

  private get logFile() {
    return this.deps.logDir ? path.join(this.deps.logDir, "forecasts.jsonl") : null;
  }

  private async log(r: ForecastResult) {
    const file = this.logFile;
    if (!file) return;
    const rec: ForecastLogRecord = {
      schemaVersion: 1,
      recordedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
      ticker: r.ticker,
      asOfDate: r.asOfDate,
      lastCloseKRW: r.lastCloseKRW,
      horizons: r.horizons.map((h) => ({ horizon: h.horizon, probabilityUp: h.probabilityUp, direction: h.direction, confidence: h.confidence, expectedReturnPct: h.expectedReturnPct, range80Pct: h.range80Pct, backtestAccuracy: h.backtest.accuracy, edge: h.backtest.edge })),
      peers: r.trainedOn.tickers.filter((t) => t !== r.ticker),
    };
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(rec)}\n`);
  }

  async readLog(): Promise<ForecastLogRecord[]> {
    const file = this.logFile;
    if (!file) return [];
    const text = await readFile(file, "utf8").catch(() => "");
    return text.split("\n").flatMap((l) => {
      try {
        return l.trim() ? [JSON.parse(l) as ForecastLogRecord] : [];
      } catch {
        return [];
      }
    });
  }

  /** Scores every logged forecast against the closes that followed it (fetches each ticker's recent bars once). */
  async scoreLog(): Promise<{ scores: ForecastScore[]; summary: ReturnType<typeof summarizeForecastScores> }> {
    const log = await this.readLog();
    const http = this.http(4 * (new Set(log.map((r) => r.ticker)).size + 1));
    const bars = new Map<string, Bar[]>();
    for (const t of new Set(log.map((r) => r.ticker))) {
      try {
        bars.set(t, (await loadHistory(http, t, { maxPages: 2 })).bars);
      } catch {
        bars.set(t, []);
      }
    }
    const scores = log.flatMap((r) => scoreForecast(r, bars.get(r.ticker) ?? []));
    return { scores, summary: summarizeForecastScores(scores) };
  }
}

/** Pure: one row per horizon; "pending" until the h-th session after asOfDate is in `bars`. */
export function scoreForecast(r: ForecastLogRecord, bars: Bar[]): ForecastScore[] {
  const after = bars.filter((b) => b.date > r.asOfDate).sort((a, b) => a.date.localeCompare(b.date));
  return r.horizons.map((h) => {
    const t = after[h.horizon - 1];
    const actual = t ? (t.close / r.lastCloseKRW - 1) * 100 : null;
    return {
      ticker: r.ticker,
      asOfDate: r.asOfDate,
      horizon: h.horizon,
      status: t ? "scored" : "pending",
      targetDate: t?.date ?? null,
      actualReturnPct: actual,
      predictedReturnPct: h.expectedReturnPct,
      probabilityUp: h.probabilityUp,
      directionHit: actual === null || actual === 0 ? null : (h.probabilityUp >= 0.5) === actual > 0,
      withinRange80: actual === null ? null : actual >= h.range80Pct[0] && actual <= h.range80Pct[1],
      confidence: h.confidence,
    };
  });
}

export function summarizeForecastScores(rows: ForecastScore[]) {
  const by = (pred: (r: ForecastScore) => boolean) => {
    const xs = rows.filter((r) => r.status === "scored" && pred(r));
    const d = xs.filter((r) => r.directionHit !== null);
    const hits = d.filter((r) => r.directionHit).length;
    return {
      n: xs.length,
      directionAccuracy: d.length ? hits / d.length : null,
      meanAbsErrorPct: xs.length ? xs.reduce((s, r) => s + Math.abs(r.predictedReturnPct - r.actualReturnPct!), 0) / xs.length : null,
      range80Coverage: xs.length ? xs.filter((r) => r.withinRange80).length / xs.length : null,
      brier: xs.length ? xs.reduce((s, r) => s + (r.probabilityUp - (r.actualReturnPct! > 0 ? 1 : 0)) ** 2, 0) / xs.length : null,
    };
  };
  return {
    pending: rows.filter((r) => r.status === "pending").length,
    all: by(() => true),
    byHorizon: Object.fromEntries([1, 2, 3].map((h) => [h, by((r) => r.horizon === h)])),
    byConfidence: Object.fromEntries(["high", "medium", "low"].map((c) => [c, by((r) => r.confidence === c)])),
  };
}
