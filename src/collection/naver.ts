import type { HttpClient } from "./http.js";
import { classifySecurity, describeRejections } from "../domain/security.js";
import { CollectionError, issue } from "./types.js";
import type { CollectionIssue, DailyClose, NewsItem, QuoteEvidence, QuarterlyActual, ReferenceMetric, QuarterlyConsensus } from "./types.js";
import { asRecord, clip, kstDate, naverDateTime, parseAmount, plainText, str } from "./text.js";
import type { AsOf } from "./text.js";

const API = "https://m.stock.naver.com/api";
const HEADERS = { accept: "application/json", "user-agent": "yyjs-evidence-collector/1" };
const MAX_NEWS = 100;

export interface NaverResult {
  name: string | null;
  exchangeVerified: boolean;
  quote: QuoteEvidence | null;
  referenceMetrics: ReferenceMetric[];
  quarterlyConsensus: QuarterlyConsensus[];
  quarterlyActuals: QuarterlyActual[];
  dailyCloses: DailyClose[];
  news: NewsItem[];
  issues: CollectionIssue[];
}

interface NaverCtx {
  ticker: string;
  asOf: AsOf;
  http: HttpClient;
  nowIso: string;
  ttlMs: number;
  maxNewsPages: number;
}

export const normalizeTitle = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export async function collectNaver(c: NaverCtx): Promise<NaverResult> {
  const out: NaverResult = { name: null, exchangeVerified: false, quote: null, referenceMetrics: [], quarterlyConsensus: [], quarterlyActuals: [], dailyCloses: [], news: [], issues: [] };
  const get = (path: string) => c.http.json(`${API}${path}`, { headers: HEADERS, ttlMs: c.ttlMs });

  // 1. basic: exact ticker + KOSPI verification gate everything else.
  const basic = asRecord(await get(`/stock/${c.ticker}/basic`));
  if (!basic || str(basic.itemCode) !== c.ticker) throw new CollectionError("invalid_response", "Naver basic response does not match the requested ticker");
  const ex = asRecord(basic.stockExchangeType) ?? {};
  const exchange = { code: str(ex.code), name: str(ex.name), nameEng: str(ex.nameEng) };
  const isKospi = exchange.code === "KS" && [exchange.name, exchange.nameEng].some((n) => n.toUpperCase() === "KOSPI");
  if (!isKospi) {
    out.issues.push(issue("naver", "not_kospi", `Ticker ${c.ticker} is not a KOSPI listing (Naver reports ${exchange.nameEng || exchange.name || exchange.code || "unknown"})`));
    return out;
  }
  out.exchangeVerified = true;
  out.name = str(basic.stockName) || null;

  // Common stock only: preferred shares, ETF/ETN, REITs and similar vehicles stop here (no quote/news is collected).
  const rejections = classifySecurity({ ticker: c.ticker, names: [out.name], endType: str(basic.stockEndType) });
  if (rejections.length) {
    out.issues.push(issue("naver", "not_common_stock", `Ticker ${c.ticker} (${out.name ?? "?"}) is not a common stock: ${describeRejections(rejections)}`));
    return out;
  }

  const close = parseAmount(str(basic.closePrice));
  const tradedMs = Date.parse(str(basic.localTradedAt));
  if (close === null || close <= 0 || Number.isNaN(tradedMs)) {
    out.issues.push(issue("naver", "invalid_quote", "Naver quote has an unparseable closePrice or localTradedAt"));
  } else if (tradedMs > c.asOf.cutoffMs) {
    out.issues.push(issue("naver", "future_quote", `Latest Naver quote (${new Date(tradedMs).toISOString()}) is after asOf; not usable for a historical analysis date`, "warning"));
  } else {
    out.quote = {
      ticker: c.ticker,
      name: out.name ?? "",
      exchange,
      close,
      currency: "KRW",
      tradedAt: str(basic.localTradedAt),
      retrievedAt: c.nowIso,
      kind: "latest_snapshot",
      tradedOnAsOfDate: kstDate(tradedMs) === c.asOf.dateKst,
      sourceUrl: `${API}/stock/${c.ticker}/basic`,
    };
  }

  // 2. integration snapshot (current values only) and 3. news run independently.
  const [ref, news, consensus, prices] = await Promise.allSettled([collectReference(c, get), collectNews(c, get), collectQuarterlyConsensus(c, get), collectDailyCloses(c, get)]);
  if (ref.status === "fulfilled") {
    out.referenceMetrics = ref.value.metrics;
    out.issues.push(...ref.value.issues);
  } else out.issues.push(toIssue("reference_failed", ref.reason));
  if (news.status === "fulfilled") {
    out.news = news.value.items;
    out.issues.push(...news.value.issues);
  } else out.issues.push(toIssue("news_failed", news.reason));
  if (consensus.status === "fulfilled") {
    out.quarterlyConsensus = consensus.value.items;
    out.quarterlyActuals = consensus.value.actuals;
    out.issues.push(...consensus.value.issues);
  } else out.issues.push({ ...toIssue("consensus_failed", consensus.reason), severity: "warning" });
  if (prices.status === "fulfilled") {
    out.dailyCloses = prices.value.items;
    out.issues.push(...prices.value.issues);
  } else out.issues.push({ ...toIssue("price_history_failed", prices.reason), severity: "warning" });
  return out;
}

/** Naver's finance table displays statement amounts in KRW 100 million and EPS in KRW per share.
 * Select only columns explicitly marked Y; a future-looking date alone is not a consensus marker.
 * The endpoint does not declare consolidated/basic/diluted scope, so preserve that uncertainty. */
export function parseQuarterlyConsensus(raw: unknown, ticker: string, observedAt: string): QuarterlyConsensus[] {
  const body = asRecord(raw);
  const info = asRecord(body?.financeInfo);
  if (body?.itemCode !== ticker || info?.itemCode !== ticker || body?.financePeriodType !== "quarter" || !Array.isArray(info.trTitleList) || !Array.isArray(info.rowList))
    throw new CollectionError("invalid_response", "Naver quarterly finance response has invalid ticker, period or table");
  const rows = info.rowList.map(asRecord);
  const value = (title: string, key: string, multiplier: number) => {
    const matches = rows.filter((r) => r?.title === title);
    if (matches.length !== 1) return null;
    const cell = asRecord(asRecord(matches[0]?.columns)?.[key]);
    const n = parseAmount(cell?.value);
    const result = n === null ? null : n * multiplier;
    return result !== null && Number.isFinite(result) && Math.abs(result) <= 1e18 ? result : null;
  };
  const items: QuarterlyConsensus[] = [];
  const keys = info.trTitleList.map(asRecord);
  for (const col of keys.slice(0, 20)) {
    const key = str(col?.key);
    if (col?.isConsensus !== "Y" || !/^\d{4}(03|06|09|12)$/.test(key) || keys.filter((k) => k?.key === key).length !== 1) continue;
    const item: QuarterlyConsensus = {
      ticker, quarter: `${key.slice(0, 4)}Q${Number(key.slice(4)) / 3}`,
      revenueKRW: value("매출액", key, 1e8), operatingProfitKRW: value("영업이익", key, 1e8),
      netIncomeKRW: value("당기순이익", key, 1e8), epsKRW: value("EPS", key, 1),
      scope: "provider_default", epsBasis: "unspecified", observedAt,
      sourceUrl: `${API}/stock/${ticker}/finance/quarter`,
    };
    if ([item.revenueKRW, item.operatingProfitKRW, item.netIncomeKRW, item.epsKRW].some((n) => n !== null)) items.push(item);
  }
  return items.sort((a, b) => a.quarter.localeCompare(b.quarter));
}

/** Reported quarters (columns explicitly marked N) with a parseable EPS, from the same table as the consensus. */
export function parseQuarterlyActuals(raw: unknown, ticker: string, observedAt: string): QuarterlyActual[] {
  const body = asRecord(raw);
  const info = asRecord(body?.financeInfo);
  if (body?.itemCode !== ticker || info?.itemCode !== ticker || body?.financePeriodType !== "quarter" || !Array.isArray(info.trTitleList) || !Array.isArray(info.rowList))
    throw new CollectionError("invalid_response", "Naver quarterly finance response has invalid ticker, period or table");
  const eps = info.rowList.map(asRecord).filter((r) => r?.title === "EPS");
  if (eps.length !== 1) return [];
  const keys = info.trTitleList.map(asRecord);
  const out: QuarterlyActual[] = [];
  for (const col of keys.slice(0, 20)) {
    const key = str(col?.key);
    if (col?.isConsensus !== "N" || !/^\d{4}(03|06|09|12)$/.test(key) || keys.filter((k) => k?.key === key).length !== 1) continue;
    const v = parseAmount(asRecord(asRecord(eps[0]?.columns)?.[key])?.value);
    if (v === null || !Number.isFinite(v) || Math.abs(v) > 1e9) continue;
    out.push({ ticker, quarter: `${key.slice(0, 4)}Q${Number(key.slice(4)) / 3}`, epsKRW: v, scope: "provider_default", epsBasis: "unspecified", observedAt, sourceUrl: `${API}/stock/${ticker}/finance/quarter` });
  }
  return out.sort((a, b) => a.quarter.localeCompare(b.quarter));
}

async function collectQuarterlyConsensus(c: NaverCtx, get: (p: string) => Promise<unknown>) {
  if (Date.parse(c.nowIso) > c.asOf.cutoffMs)
    return { items: [], actuals: [], issues: [issue("naver", "consensus_snapshot_after_asOf", "분기 컨센서스·실적 표는 현재 스냅샷이므로 과거 기준일에 소급 적용하지 않습니다.", "info")] };
  const raw = await get(`/stock/${c.ticker}/finance/quarter`);
  const items = parseQuarterlyConsensus(raw, c.ticker, c.nowIso);
  const actuals = parseQuarterlyActuals(raw, c.ticker, c.nowIso);
  return { items, actuals, issues: items.length ? [] : [issue("naver", "quarterly_consensus_unavailable", "공급자가 컨센서스로 표시한 분기 추정치가 없습니다.", "info")] };
}

const PRICE_PAGE_SIZE = 60; // Naver's largest accepted page size
const PRICE_MAX_PAGES = 3; // ~180 sessions: enough for the quarter before a forecast quarter up to two quarters back
const PRICE_LOOKBACK_DAYS = 200;

/** Daily closes on or before asOf, newest first. Live runs only (a historical asOf would need pages back from today). */
async function collectDailyCloses(c: NaverCtx, get: (p: string) => Promise<unknown>): Promise<{ items: DailyClose[]; issues: CollectionIssue[] }> {
  if (Date.parse(c.nowIso) > c.asOf.cutoffMs) return { items: [], issues: [] };
  const oldest = kstDate(c.asOf.cutoffMs - PRICE_LOOKBACK_DAYS * 86_400_000);
  const byDate = new Map<string, number>();
  for (let page = 1; page <= PRICE_MAX_PAGES; page++) {
    const rows = await get(`/stock/${c.ticker}/price?pageSize=${PRICE_PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(rows)) throw new CollectionError("invalid_response", "Naver daily price response is not a list");
    let earliest = "9999-12-31";
    for (const r of rows.map(asRecord)) {
      const date = str(r?.localTradedAt);
      const close = parseAmount(str(r?.closePrice));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || close === null || close <= 0) continue;
      if (date < earliest) earliest = date;
      if (date <= c.asOf.dateKst) byDate.set(date, close);
    }
    if (rows.length < PRICE_PAGE_SIZE || earliest < oldest) break;
  }
  const items = [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, closeKRW]) => ({ date, closeKRW }));
  return { items, issues: items.length ? [] : [issue("naver", "price_history_unavailable", "일별 시세를 가져오지 못했습니다.", "warning")] };
}

const toIssue = (code: string, e: unknown): CollectionIssue =>
  issue("naver", e instanceof CollectionError ? e.code : code, e instanceof Error ? e.message : String(e));

async function collectReference(c: NaverCtx, get: (p: string) => Promise<unknown>) {
  const issues: CollectionIssue[] = [];
  const raw = asRecord(await get(`/stock/${c.ticker}/integration`));
  const infos = raw?.totalInfos;
  if (!Array.isArray(infos)) throw new CollectionError("invalid_response", "Naver integration response has no totalInfos");
  if (kstDate(Date.parse(c.nowIso)) > c.asOf.dateKst) {
    issues.push(issue("naver", "snapshot_after_asOf", "Naver integration values are a current snapshot; excluded for a historical asOf to avoid lookahead", "warning"));
    return { metrics: [], issues };
  }
  const metrics: ReferenceMetric[] = [];
  for (const item of infos.slice(0, 40)) {
    const o = asRecord(item);
    const code = str(o?.code);
    if (!o || !code) continue;
    const rawValue = str(o.value);
    const m = /^(-?[\d,]+(?:\.\d+)?)\s*(배|원|%)?$/.exec(rawValue.trim());
    metrics.push({
      code,
      label: clip(str(o.key), 80),
      rawValue: clip(rawValue, 80),
      rawDescription: o.valueDesc == null ? null : clip(str(o.valueDesc), 80),
      value: m ? parseAmount(m[1]) : null,
      unit: m?.[2] ?? null,
      role: /^(per|eps|pbr|bps|dividend)/i.test(code) ? "trailing_reference" : /^cns/i.test(code) ? "consensus_reference" : /^marketValue$/i.test(code) ? "market_value_reference" : "other_reference",
      usableAsModelInput: false,
      retrievedAt: c.nowIso,
      sourceUrl: `${API}/stock/${c.ticker}/integration`,
    });
  }
  return { metrics, issues };
}

function newsUrl(officeId: string, articleId: string, mobile: unknown): string | null {
  const m = str(mobile);
  if (m.startsWith("https://")) {
    try {
      return new URL(m).href;
    } catch {
      /* fall through to constructed URL */
    }
  }
  return /^\d+$/.test(officeId) && /^\d+$/.test(articleId) ? `https://n.news.naver.com/article/${officeId}/${articleId}` : null;
}

async function collectNews(c: NaverCtx, get: (p: string) => Promise<unknown>) {
  const issues: CollectionIssue[] = [];
  const items: NewsItem[] = [];
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  let future = 0;
  const pages = Math.max(1, Math.min(3, c.maxNewsPages));
  for (let page = 1; page <= pages && items.length < MAX_NEWS; page++) {
    let groups: unknown;
    try {
      groups = await get(`/news/stock/${c.ticker}?pageSize=20&page=${page}`);
    } catch (e) {
      if (page === 1) throw e;
      issues.push(issue("naver", "news_page_failed", `News page ${page} failed: ${(e as Error).message}`, "warning"));
      break;
    }
    if (!Array.isArray(groups)) throw new CollectionError("invalid_response", "Naver news response is not an array");
    let seen = 0;
    for (const g of groups) {
      const list = asRecord(g)?.items;
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        seen++;
        const o = asRecord(raw);
        if (!o) continue;
        const publishedAt = naverDateTime(o.datetime);
        const title = plainText(str(o.title));
        const officeId = str(o.officeId);
        const articleId = str(o.articleId);
        const url = newsUrl(officeId, articleId, o.mobileNewsUrl);
        if (!publishedAt || !title || !url) continue;
        if (Date.parse(publishedAt) > c.asOf.cutoffMs) {
          future++;
          continue;
        }
        const id = officeId && articleId ? `${officeId}:${articleId}` : str(o.id) || url;
        const nt = normalizeTitle(title);
        if (seenIds.has(id) || seenTitles.has(nt)) continue;
        seenIds.add(id);
        seenTitles.add(nt);
        items.push({
          id,
          title: clip(title, 300),
          snippet: clip(plainText(str(o.body)), 500),
          publishedAt,
          officeName: str(o.officeName) || null,
          url,
          originalUrl: null,
          origin: "naver-stock-news",
        });
      }
    }
    if (seen === 0) break;
  }
  if (future) issues.push(issue("naver", "future_news_excluded", `${future} news item(s) after asOf were excluded`, "info"));
  items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return { items: items.slice(0, MAX_NEWS), issues };
}

/** Optional official Naver Open API news search for product-market query expansion. */
export async function collectNaverSearch(
  queries: string[],
  asOf: AsOf,
  http: HttpClient,
  creds: { id: string; secret: string },
  ttlMs: number,
): Promise<{ items: NewsItem[]; issues: CollectionIssue[] }> {
  const items: NewsItem[] = [];
  const issues: CollectionIssue[] = [];
  const seen = new Set<string>();
  const seenTitles = new Set<string>();
  const headers = { accept: "application/json", "X-Naver-Client-Id": creds.id, "X-Naver-Client-Secret": creds.secret };
  for (const q of queries.slice(0, 6)) {
    const query = q.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 100);
    if (!query) continue;
    try {
      const url = `https://openapi.naver.com/v1/search/news.json?${new URLSearchParams({ query, display: "20", sort: "date" })}`;
      const body = asRecord(await http.json(url, { headers, ttlMs }));
      const list = body?.items;
      if (!Array.isArray(list)) throw new CollectionError("invalid_response", "Naver search response has no items");
      for (const raw of list) {
        const o = asRecord(raw);
        const ms = Date.parse(str(o?.pubDate));
        const link = str(o?.link);
        const title = plainText(str(o?.title));
        if (!o || Number.isNaN(ms) || ms > asOf.cutoffMs || !link.startsWith("https://") || !title) continue;
        const key = str(o.originallink) || link;
        const nt = normalizeTitle(title);
        if (seen.has(key) || seenTitles.has(nt)) continue;
        seen.add(key);
        seenTitles.add(nt);
        const kst = new Date(ms + 9 * 3600_000).toISOString().slice(0, 19);
        items.push({
          id: key,
          title: clip(title, 300),
          snippet: clip(plainText(str(o.description)), 500),
          publishedAt: `${kst}+09:00`,
          officeName: null,
          url: link,
          originalUrl: str(o.originallink).startsWith("https://") ? str(o.originallink) : null,
          origin: "naver-search",
        });
      }
    } catch (e) {
      issues.push(issue("naver-search", e instanceof CollectionError ? e.code : "search_failed", `Query "${query}": ${(e as Error).message}`));
    }
  }
  items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return { items: items.slice(0, MAX_NEWS), issues };
}
