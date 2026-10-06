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
