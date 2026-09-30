import { createHttp } from "./http.js";
import type { HttpClient } from "./http.js";
import { collectDartRevenue } from "./dart.js";
import { collectSecRevenue } from "./sec.js";
import { collectEdinetRevenue } from "./edinet.js";
import { CollectionError, CollectionInputError, issue } from "./types.js";
import type { AsOf } from "./text.js";
import type { CollectionIssue, CompetitorEvidence, CompetitorMarket, ProviderName, ProviderReport } from "./types.js";
export { calendarPeriodOf } from "./period.js";

// Competitor revenue from the three disclosure systems this server supports for global comparison -- Korea (DART),
// the United States (SEC EDGAR) and Japan (EDINET). Other countries are rejected at input: a comparison only ever
// names KR/US/JP companies (everything else stays in the market's "others" remainder).

export const MAX_COMPETITORS = 6;
const CODE: Record<CompetitorMarket, RegExp> = {
  KR: /^\d{6}$/, // KRX ticker
  US: /^[A-Z][A-Z0-9.-]{0,9}$/, // EDGAR ticker (BRK-B ...)
  JP: /^[0-9][0-9A-Z]{3}$/, // TSE securities code (7203, 130A ...)
};
const PROVIDER: Record<CompetitorMarket, ProviderName> = { KR: "dart", US: "sec", JP: "edinet" };

export type CompetitorId = { market: CompetitorMarket; code: string };

/** "KR:000660" / "us:mu" / "JP:8035" -> {market, code}; anything else (other countries, bad codes) throws. */
export function parseCompetitorIds(raw: unknown[] | undefined, self?: string): CompetitorId[] {
  const out: CompetitorId[] = [];
  for (const r of raw ?? []) {
    const m = /^\s*(KR|US|JP)\s*:\s*(\S+)\s*$/i.exec(typeof r === "string" ? r : "");
    const market = m?.[1]?.toUpperCase() as CompetitorMarket | undefined;
    const code = m?.[2]?.toUpperCase() ?? "";
    if (!market || !CODE[market].test(code))
      throw new CollectionInputError(`competitors must look like KR:000660, US:MU or JP:8035 (Korea, US and Japan only); got "${String(r).slice(0, 30)}"`);
    if (market === "KR" && code === self) continue; // the analysed company is not its own competitor
    if (!out.some((x) => x.market === market && x.code === code)) out.push({ market, code });
  }
  if (out.length > MAX_COMPETITORS) throw new CollectionInputError(`at most ${MAX_COMPETITORS} competitors`);
  return out;
}

export type CompetitorCtx = {
  asOf: AsOf;
  fetch: typeof fetch;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  secrets: string[];
  ttlMs: number;
  dart: { key: string; corpCodeTtlMs: number; zip: import("./zip.js").ZipLimits } | null;
  secUserAgent: string | null;
  edinetKey: string | null;
};

// Per-company request budgets, separate from the main collection budget so competitors never starve it.
const BUDGET: Record<CompetitorMarket, number> = { KR: 16, US: 2, JP: 70 };

export async function collectCompetitors(
  ids: CompetitorId[],
  c: CompetitorCtx,
): Promise<{ competitors: CompetitorEvidence[]; reports: Partial<Record<CompetitorMarket, ProviderReport>> }> {
  const issuesBy: Partial<Record<CompetitorMarket, CollectionIssue[]>> = {};
  const configured: Record<CompetitorMarket, boolean> = { KR: !!c.dart, US: !!c.secUserAgent, JP: !!c.edinetKey };
  const missingKey: Record<CompetitorMarket, string> = { KR: "DART_API_KEY", US: "SEC_USER_AGENT", JP: "EDINET_API_KEY" };
  const http = (m: CompetitorMarket): HttpClient =>
    createHttp({ fetch: c.fetch, timeoutMs: c.timeoutMs, maxBytes: c.maxBytes, maxRequests: BUDGET[m], secrets: c.secrets, signal: c.signal });

  const one = async (id: CompetitorId): Promise<CompetitorEvidence | null> => {
    const list = (issuesBy[id.market] ??= []);
    if (!configured[id.market]) {
      if (!list.some((i) => i.code === "missing_configuration"))
        list.push(issue(PROVIDER[id.market], "missing_configuration", `${missingKey[id.market]} is not set; ${id.market} competitors were not collected`, "warning"));
      return null;
    }
    try {
      const r =
        id.market === "KR" ? await collectDartRevenue({ code: id.code, asOf: c.asOf, http: http("KR"), ttlMs: c.ttlMs, ...c.dart! })
        : id.market === "US" ? await collectSecRevenue({ ticker: id.code, asOf: c.asOf, http: http("US"), userAgent: c.secUserAgent!, ttlMs: c.ttlMs })
        : await collectEdinetRevenue({ code: id.code, asOf: c.asOf, http: http("JP"), key: c.edinetKey!, ttlMs: c.ttlMs });
      list.push(...r.issues);
      if (r.evidence && !r.evidence.periods.length) {
        list.push(issue(PROVIDER[id.market], "no_revenue_periods", `${id.market}:${id.code}: no revenue filed on or before asOf`, "warning"));
        return null;
      }
      return r.evidence;
    } catch (e) {
      list.push(issue(PROVIDER[id.market], e instanceof CollectionError ? e.code : "competitor_failed", `${id.market}:${id.code}: ${(e as Error).message}`));
      return null;
    }
  };

  // Markets run in parallel; companies within a market run one after another (SEC/EDINET fair-use limits).
  const markets = [...new Set(ids.map((i) => i.market))];
  const results = await Promise.all(markets.map(async (m) => {
    const got: CompetitorEvidence[] = [];
    for (const id of ids.filter((i) => i.market === m)) {
      const r = await one(id);
      if (r) got.push(r);
    }
    return got;
  }));
  const competitors = ids.flatMap((id) => results.flat().filter((r) => r.market === id.market && r.code === id.code));

  const reports: Partial<Record<CompetitorMarket, ProviderReport>> = {};
  for (const m of markets) {
    const issues = issuesBy[m] ?? [];
    const got = competitors.filter((x) => x.market === m).length;
    const wanted = ids.filter((x) => x.market === m).length;
    reports[m] = {
      status: !configured[m] ? "not_configured" : got === 0 ? "failed" : got < wanted || issues.some((i) => i.severity === "error") ? "partial" : "ok",
      issues,
    };
  }
  return { competitors, reports };
}
