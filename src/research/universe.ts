import { classifySecurity } from "../domain/security.js";

// Selectable list of KOSPI common stocks for the web UI, from Naver's public market-cap listing
// (fixed host/path, no user-supplied URL). ETF/ETN are dropped by `stockEndType`; preferred shares, REITs,
// infrastructure funds and SPACs by the same rules the analysis gate uses. Cached in memory; a failed refresh
// serves the stale list.

export type UniverseItem = { ticker: string; name: string; marketCapKRW: number };
export type Universe = { items: UniverseItem[]; fetchedAt: string; scanned: number };

const LIST_URL = "https://m.stock.naver.com/api/stocks/marketValue/KOSPI";
const PAGE_SIZE = 100;
const MAX_PAGES = 40; // hard cap on upstream requests (KOSPI incl. ETFs is ~2,500 rows)
const CONCURRENCY = 4;

type Fetch = typeof fetch;

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

async function page(fetchFn: Fetch, n: number, signal?: AbortSignal): Promise<{ rows: unknown[]; total: number }> {
  const timeout = AbortSignal.timeout(15_000);
  const res = await fetchFn(`${LIST_URL}?page=${n}&pageSize=${PAGE_SIZE}`, {
    headers: { accept: "application/json", "user-agent": "yyjs-universe/1" },
    redirect: "manual",
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  if (!res.ok) throw new Error(`Naver listing HTTP ${res.status}`);
  const body = rec(await res.json());
  const stocks = body?.stocks;
  if (!Array.isArray(stocks)) throw new Error("Naver listing response has no stocks array");
  return { rows: stocks, total: Number(body?.totalCount) || 0 };
}

export function toItem(raw: unknown): UniverseItem | null {
  const o = rec(raw);
  if (!o) return null;
  const ticker = text(o.itemCode);
  const name = text(o.stockName).trim();
  const ex = rec(o.stockExchangeType);
  if (!/^\d{6}$/.test(ticker) || !name || (ex && text(ex.code) !== "KS")) return null;
  if (classifySecurity({ ticker, names: [name], endType: text(o.stockEndType) }).length) return null;
  // marketValue is in 억원 ("15,755,721" = 1,575조 5,721억)
  const eok = Number(text(o.marketValue).replace(/,/g, ""));
  return { ticker, name, marketCapKRW: Number.isFinite(eok) ? eok * 100_000_000 : 0 };
}

export class UniverseProvider {
  private cached: Universe | null = null;
  private inflight: Promise<Universe> | null = null;

  constructor(
    private opts: { fetch?: Fetch; now?: () => Date; ttlMs?: number } = {},
  ) {}

  async get(signal?: AbortSignal): Promise<Universe> {
    const now = (this.opts.now ?? (() => new Date()))().getTime();
    if (this.cached && now - Date.parse(this.cached.fetchedAt) < (this.opts.ttlMs ?? 6 * 3600_000)) return this.cached;
    this.inflight ??= this.load(signal).finally(() => (this.inflight = null));
    try {
      return await this.inflight;
    } catch (e) {
      if (this.cached) return this.cached; // stale beats nothing
      throw e;
    }
  }

  private async load(signal?: AbortSignal): Promise<Universe> {
    const fetchFn = this.opts.fetch ?? fetch;
    const first = await page(fetchFn, 1, signal);
    const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(first.total / PAGE_SIZE)));
    const rows = [...first.rows];
    let next = 2;
    const worker = async () => {
      for (let n = next++; n <= pages; n = next++) rows.push(...(await page(fetchFn, n, signal)).rows);
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pages - 1) }, worker));
    const seen = new Set<string>();
    const items: UniverseItem[] = [];
    for (const r of rows) {
      const it = toItem(r);
      if (it && !seen.has(it.ticker)) (seen.add(it.ticker), items.push(it));
    }
    if (!items.length) throw new Error("Naver listing contained no common stocks");
    items.sort((a, b) => b.marketCapKRW - a.marketCapKRW || a.ticker.localeCompare(b.ticker));
    this.cached = { items, fetchedAt: (this.opts.now ?? (() => new Date()))().toISOString(), scanned: rows.length };
    return this.cached;
  }

  static search(u: Universe, query: string | undefined, limit: number): { total: number; items: UniverseItem[] } {
    const q = query?.trim().toLowerCase();
    const hits = q ? u.items.filter((i) => i.ticker.startsWith(q) || i.name.toLowerCase().includes(q)) : u.items;
    return { total: hits.length, items: hits.slice(0, limit) };
  }
}
