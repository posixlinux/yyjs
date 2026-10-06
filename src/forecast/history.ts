import type { HttpClient } from "../collection/http.js";
import { CollectionError } from "../collection/types.js";
import { asRecord, parseAmount, str } from "../collection/text.js";
import { exchangeOf, type ListedExchange } from "../domain/security.js";

// Daily OHLCV history from Naver's public mobile API (the same host the evidence collector already uses). Bars are
// returned oldest first. Open/high/low/volume are optional: a row without them still carries a close.

const API = "https://m.stock.naver.com/api";
const HEADERS = { accept: "application/json", "user-agent": "yyjs-forecast/1" };
export const PAGE_SIZE = 60; // Naver's largest accepted page size

export type Bar = { date: string; open: number | null; high: number | null; low: number | null; close: number; volume: number | null };

const positive = (v: unknown): number | null => {
  const n = parseAmount(typeof v === "number" ? v : str(v));
  return n !== null && n > 0 ? n : null;
};

/** Naver price rows -> bars (oldest first, one per date, rows without a valid date/close dropped). */
export function parseBars(rows: unknown): Bar[] {
  if (!Array.isArray(rows)) throw new CollectionError("invalid_response", "Naver price response is not a list");
  const byDate = new Map<string, Bar>();
  for (const r of rows.map(asRecord)) {
    const date = str(r?.localTradedAt).slice(0, 10);
    const close = positive(r?.closePrice);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || close === null) continue;
    const vol = parseAmount(str(r?.accumulatedTradingVolume));
    byDate.set(date, { date, open: positive(r?.openPrice), high: positive(r?.highPrice), low: positive(r?.lowPrice), close, volume: vol !== null && vol >= 0 ? vol : null });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function pages(http: HttpClient, path: string, maxPages: number, ttlMs: number): Promise<Bar[]> {
  const all = new Map<string, Bar>();
  for (let page = 1; page <= maxPages; page++) {
    const raw = await http.json(`${API}${path}${path.includes("?") ? "&" : "?"}pageSize=${PAGE_SIZE}&page=${page}`, { headers: HEADERS, ttlMs });
    const bars = parseBars(raw);
    for (const b of bars) all.set(b.date, b);
    if (!Array.isArray(raw) || raw.length < PAGE_SIZE) break;
  }
  return [...all.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export type StockHistory = { ticker: string; name: string | null; exchange: ListedExchange; bars: Bar[] };
export type History = StockHistory & { index: Bar[]; indexName: string };

export async function loadStock(http: HttpClient, ticker: string, opts: { maxPages?: number; ttlMs?: number } = {}): Promise<StockHistory> {
  const maxPages = opts.maxPages ?? 12; // ~720 sessions (about three years)
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const basic = asRecord(await http.json(`${API}/stock/${ticker}/basic`, { headers: HEADERS, ttlMs }));
  if (!basic || str(basic.itemCode) !== ticker) throw new CollectionError("invalid_response", "Naver basic response does not match the requested ticker");
  const exchange = exchangeOf(str(asRecord(basic.stockExchangeType)?.code));
  if (!exchange) throw new CollectionError("not_listed", `Ticker ${ticker} is not a KOSPI/KOSDAQ listing`);
  return { ticker, name: str(basic.stockName) || null, exchange, bars: await pages(http, `/stock/${ticker}/price`, maxPages, ttlMs) };
}

export const loadIndex = (http: HttpClient, exchange: ListedExchange, opts: { maxPages?: number; ttlMs?: number } = {}): Promise<Bar[]> =>
  pages(http, `/index/${exchange}/price`, opts.maxPages ?? 12, opts.ttlMs ?? 10 * 60_000);

/** The stock's bars and its exchange index (KOSPI or KOSDAQ) over up to `maxPages` x 60 sessions. */
export async function loadHistory(http: HttpClient, ticker: string, opts: { maxPages?: number; ttlMs?: number } = {}): Promise<History> {
  const stock = await loadStock(http, ticker, opts);
  return { ...stock, index: await loadIndex(http, stock.exchange, opts), indexName: stock.exchange };
}

/**
 * USD/KRW ECB reference rates (Frankfurter) between two dates, oldest first, as close-only bars. Each rate is dated
 * by its ECB publication day; the feature code lags it by a session (see alignLagged).
 */
export async function loadUsdKrw(http: HttpClient, from: string, to: string, ttlMs = 6 * 3600_000): Promise<Bar[]> {
  const raw = asRecord(await http.json(`https://api.frankfurter.dev/v1/${from}..${to}?base=USD&symbols=KRW`, { headers: { accept: "application/json" }, ttlMs }));
  const rates = asRecord(raw?.rates);
  if (!rates) throw new CollectionError("invalid_response", "Frankfurter response has no rates");
  return Object.entries(rates)
    .flatMap(([date, v]) => {
      const krw = Number(asRecord(v)?.KRW);
      return /^\d{4}-\d{2}-\d{2}$/.test(date) && krw > 0 ? [{ date, open: null, high: null, low: null, close: krw, volume: null }] : [];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * KRX limits a session's move to +-30% of the previous close, so a larger close-to-close jump is a corporate action.
 * One whose ratio sits within 8% of a split or consolidation factor (1/2, 1/5, x10, ...) is folded into the earlier
 * bars, so a 1:5 split is not an -80% crash. Any other jump (a relisting after a long halt, a base-price reset after
 * a merger or capital reduction) cannot be adjusted reliably, so the history before it is dropped rather than
 * rescaled into fabricated prices.
 */
const SPLIT_FACTORS = [2, 3, 4, 5, 8, 10, 20, 25, 50, 100];
export function adjustCorporateActions(bars: Bar[], limit = 0.3): { bars: Bar[]; adjusted: string[]; truncatedBefore: string | null } {
  const out = bars.map((b) => ({ ...b }));
  const adjusted: string[] = [];
  let factor = 1;
  for (let i = out.length - 1; i > 0; i--) {
    const ratio = bars[i]!.close / bars[i - 1]!.close;
    if (ratio > 1 + limit + 0.01 || ratio < 1 - limit - 0.01) {
      const k = ratio < 1 ? 1 / ratio : ratio;
      const nearSplit = SPLIT_FACTORS.some((f) => Math.abs(k / f - 1) <= 0.08);
      if (!nearSplit) return { bars: out.slice(i), adjusted: adjusted.reverse(), truncatedBefore: bars[i]!.date };
      factor *= ratio;
      adjusted.push(bars[i]!.date);
    }
    if (factor !== 1) {
      const b = out[i - 1]!;
      const scale = (v: number | null) => (v === null ? null : v * factor);
      out[i - 1] = { ...b, open: scale(b.open), high: scale(b.high), low: scale(b.low), close: b.close * factor, volume: b.volume === null ? null : b.volume / factor };
    }
  }
  return { bars: out, adjusted: adjusted.reverse(), truncatedBefore: null };
}

/**
 * Drops a bar dated today (KST) before the session is over (15:40 KST, ten minutes after the closing auction): during
 * market hours it is a partial session whose "close" and volume would be taken for final values.
 */
export function dropUnfinishedSession(bars: Bar[], now: Date): Bar[] {
  const k = new Date(now.getTime() + 9 * 3_600_000);
  const today = k.toISOString().slice(0, 10);
  const minutes = k.getUTCHours() * 60 + k.getUTCMinutes();
  return bars.length && bars.at(-1)!.date === today && minutes < 15 * 60 + 40 ? bars.slice(0, -1) : bars;
}

/** Net buying by foreign and institutional investors for one session, in shares (positive = net buy). */
export type Flow = { date: string; foreign: number | null; organ: number | null };

const signedAmount = (v: unknown): number | null => {
  const t = (typeof v === "number" ? String(v) : typeof v === "string" ? v : "").replace(/[,+\s]/g, "");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};

/**
 * Investor net buying from Naver's investor-trend rows. The field names were not verifiable against live responses
 * in development, so they are matched loosely (bizdate / localTradedAt; foreigner*PureBuy*, organ*PureBuy*); rows
 * that match nothing are skipped and the caller treats an empty result as "no flow data".
 */
export function parseFlows(rows: unknown): Flow[] {
  if (!Array.isArray(rows)) return [];
  const out = new Map<string, Flow>();
  for (const r of rows.map(asRecord)) {
    if (!r) continue;
    const rawDate = str(r.bizdate ?? r.localTradedAt ?? r.tradeDate);
    const date = /^\d{8}$/.test(rawDate) ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}` : rawDate.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const pick = (re: RegExp) => {
      const k = Object.keys(r).find((x) => re.test(x));
      return k ? signedAmount(r[k]) : null;
    };
    const foreign = pick(/^foreigner.*pure.*buy.*(quant|volume)?$/i), organ = pick(/^organ.*pure.*buy.*(quant|volume)?$/i);
    if (foreign === null && organ === null) continue;
    out.set(date, { date, foreign, organ });
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function loadFlows(http: HttpClient, ticker: string, maxPages = 12, ttlMs = 10 * 60_000): Promise<Flow[]> {
  const all = new Map<string, Flow>();
  for (let page = 1; page <= maxPages; page++) {
    const raw = await http.json(`${API}/stock/${ticker}/trend?pageSize=${PAGE_SIZE}&page=${page}`, { headers: HEADERS, ttlMs });
    const rows = parseFlows(raw);
    for (const f of rows) all.set(f.date, f);
    if (!Array.isArray(raw) || raw.length < PAGE_SIZE || !rows.length) break;
  }
  return [...all.values()].sort((a, b) => a.date.localeCompare(b.date));
}
