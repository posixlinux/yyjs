import type { HttpClient } from "./http.js";
import { classifySecurity, describeRejections } from "../domain/security.js";
import { CollectionError, issue } from "./types.js";
import type { CollectionIssue, NewsItem, QuoteEvidence, ReferenceMetric } from "./types.js";
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
  const out: NaverResult = { name: null, exchangeVerified: false, quote: null, referenceMetrics: [], news: [], issues: [] };
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
  const [ref, news] = await Promise.allSettled([collectReference(c, get), collectNews(c, get)]);
  if (ref.status === "fulfilled") {
    out.referenceMetrics = ref.value.metrics;
    out.issues.push(...ref.value.issues);
  } else out.issues.push(toIssue("reference_failed", ref.reason));
  if (news.status === "fulfilled") {
    out.news = news.value.items;
    out.issues.push(...news.value.issues);
  } else out.issues.push(toIssue("news_failed", news.reason));
  return out;
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
  for (const q of queries.slice(0, 5)) {
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
