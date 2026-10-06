import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createHttp } from "../collection/http.js";
import { CollectionError } from "../collection/types.js";
import { AppError } from "../errors.js";
import type { UniverseProvider } from "../research/universe.js";
import { DEFAULT_OPTIONS, forecast, type EngineOptions, type ForecastResult, type Series } from "./engine.js";
import { loadHistory, type Bar } from "./history.js";

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

export class ForecastService {
  private cache = new Map<string, { at: number; result: ForecastResult }>();

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

  async run(ticker: string, opts: { peers?: string[]; peerCount?: number } = {}): Promise<ForecastResult & { peerFailures: string[] }> {
    const peerCount = opts.peerCount ?? 20;
    const key = `${ticker}|${(opts.peers ?? []).join(",")}|${peerCount}`;
    const now = (this.deps.now ?? (() => new Date()))().getTime();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < 30 * 60_000) return { ...hit.result, peerFailures: [] };

    const pages = this.deps.pages ?? 12;
    const http = this.http((2 + pages * 2) * (2 + Math.min(MAX_PEERS, opts.peers?.length ?? peerCount)));
    let target;
    try {
      target = await loadHistory(http, ticker, { maxPages: pages });
    } catch (e) {
      if (e instanceof CollectionError && e.code === "not_listed") throw new AppError(422, "NOT_LISTED", e.message);
      throw new AppError(502, "HISTORY_UNAVAILABLE", `Could not load ${ticker}'s price history: ${(e as Error).message}`);
    }
    const peerFailures: string[] = [];
    const peers: Series[] = [];
    const tickers = await this.peerTickers(ticker, target.exchange, opts.peers, peerCount);
    // Bounded concurrency; a failing peer is skipped, never fatal.
    for (let i = 0; i < tickers.length; i += 4) {
      const got = await Promise.allSettled(tickers.slice(i, i + 4).map((t) => loadHistory(http, t, { maxPages: pages })));
      got.forEach((g, j) => (g.status === "fulfilled" ? peers.push({ ticker: g.value.ticker, bars: g.value.bars, index: g.value.index }) : peerFailures.push(tickers[i + j]!)));
    }
    let result: ForecastResult;
    try {
      result = forecast({ ticker, bars: target.bars, index: target.index }, peers, { ...DEFAULT_OPTIONS, ...this.deps.options });
    } catch (e) {
      throw new AppError(422, "INSUFFICIENT_HISTORY", (e as Error).message);
    }
    if (target.name) result.notes.push(`${target.name} (${target.exchange}); index ${target.indexName}.`);
    if (peerFailures.length) result.notes.push(`Peers skipped (history unavailable): ${peerFailures.join(", ")}.`);
    this.cache.set(key, { at: now, result });
    await this.log(result).catch(() => result.notes.push("The forecast could not be written to the forecast log."));
    return { ...result, peerFailures };
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
