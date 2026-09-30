import type { HttpClient } from "./http.js";
import { calendarPeriodOf } from "./period.js";
import { CollectionError, issue } from "./types.js";
import { asRecord, kstDate, str } from "./text.js";
import type { AsOf } from "./text.js";
import type { CollectionIssue, CompetitorEvidence, CompetitorPeriod } from "./types.js";

// SEC EDGAR (no key; SEC requires a descriptive User-Agent with a contact). Revenue comes from the XBRL
// "companyfacts" of the filer's own 10-Q/10-K filings. A period is dated by the EARLIEST filing that reported it
// (later filings repeat it as a comparative), so nothing filed after asOf is ever used.

const TICKERS = "https://www.sec.gov/files/company_tickers.json";
const FACTS = (cik: string) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
const MAX_QUARTERS = 8;
const MAX_YEARS = 2;
// Revenue concepts in preference order; the one reported most recently wins (companies switch tags over time).
const CONCEPTS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "SalesRevenueNet",
  "SalesRevenueGoodsNet",
];
const DOMESTIC_FORMS = /^10-[QK]/;
const jsonObject = (buf: Buffer) => {
  try {
    const v: unknown = JSON.parse(buf.toString("utf8"));
    return !!v && typeof v === "object" && !Array.isArray(v);
  } catch {
    return false;
  }
}; // 20-F/40-F filers (foreign private issuers) are not US companies

export interface SecCtx {
  ticker: string;
  asOf: AsOf;
  http: HttpClient;
  userAgent: string;
  ttlMs: number;
}

type Fact = { start?: string; end: string; val: number; accn: string; fy?: number; fp?: string; form: string; filed: string };

const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** EDGAR accepts filings until 22:00 US Eastern, i.e. by noon KST the next day: the conservative public instant. */
export function secAvailableAt(filed: string): number {
  return Date.parse(`${filed}T12:00:00+09:00`) + 86_400_000;
}

export async function collectSecRevenue(c: SecCtx): Promise<{ evidence: CompetitorEvidence | null; issues: CollectionIssue[] }> {
  const issues: CollectionIssue[] = [];
  const headers = { "user-agent": c.userAgent, accept: "application/json" };
  const index = await c.http.memo("sec:tickers", 24 * 3600_000, async () => {
    const raw = asRecord(await c.http.json(TICKERS, { headers, disk: { key: "sec:company_tickers", ttlMs: 86_400_000, validate: jsonObject } }));
    const m = new Map<string, { cik: string; title: string }>();
    for (const v of Object.values(raw ?? {})) {
      const o = asRecord(v);
      const t = str(o?.ticker).toUpperCase();
      const cik = typeof o?.cik_str === "number" ? String(o.cik_str) : str(o?.cik_str);
      if (t && /^\d{1,10}$/.test(cik)) m.set(t, { cik: cik.padStart(10, "0"), title: str(o?.title) });
    }
    if (!m.size) throw new CollectionError("invalid_response", "SEC company_tickers.json has no entries");
    return m;
  });
  const hit = index.get(c.ticker);
  if (!hit) throw new CollectionError("ticker_not_found", `US:${c.ticker} is not an SEC-registered ticker`);

  // companyfacts grows with every 10-Q/10-K; half a day is fresh enough (asOf filtering is by filing date anyway).
  const facts = asRecord(await c.http.json(FACTS(hit.cik), { headers, ttlMs: c.ttlMs, disk: { key: `sec:companyfacts:${hit.cik}`, ttlMs: 12 * 3_600_000, validate: jsonObject } }));
  const gaap = asRecord(asRecord(facts?.facts)?.["us-gaap"]);
  if (!gaap) throw new CollectionError("no_us_gaap", `US:${c.ticker} has no us-gaap facts (not a US GAAP 10-K/10-Q filer)`);

  const usable = (concept: string): Fact[] => {
    const units = asRecord(asRecord(gaap[concept])?.units);
    const usd = Array.isArray(units?.USD) ? units.USD : [];
    return usd
      .map((x) => asRecord(x))
      .filter((x): x is Record<string, unknown> => !!x && typeof x.val === "number" && /^\d{4}-\d{2}-\d{2}$/.test(str(x.end)) && /^\d{4}-\d{2}-\d{2}$/.test(str(x.filed)))
      .map((x) => ({ start: str(x.start) || undefined, end: str(x.end), val: x.val as number, accn: str(x.accn), fy: typeof x.fy === "number" ? x.fy : undefined, fp: str(x.fp) || undefined, form: str(x.form), filed: str(x.filed) }))
      .filter((f) => DOMESTIC_FORMS.test(f.form) && secAvailableAt(f.filed) <= c.asOf.cutoffMs);
  };
  const ranked = CONCEPTS.map((k) => ({ k, facts: usable(k) }))
    .filter((x) => x.facts.length)
    .sort((a, b) => (b.facts.reduce((m, f) => (f.end > m ? f.end : m), "") > a.facts.reduce((m, f) => (f.end > m ? f.end : m), "") ? 1 : -1));
  const best = ranked[0];
  if (!best) {
    const anyForm = Object.values(gaap).some((v) => JSON.stringify(v).includes('"form":"10-'));
    throw new CollectionError(anyForm ? "no_revenue" : "not_us_domestic", anyForm
      ? `US:${c.ticker}: no revenue fact filed on or before asOf`
      : `US:${c.ticker} does not file 10-Q/10-K (foreign private issuer); only US companies are compared`);
  }

  // One value per (start, end): the earliest filing that reported it.
  const byPeriod = new Map<string, Fact>();
  for (const f of best.facts) {
    if (!f.start) continue;
    const k = `${f.start}|${f.end}`;
    const prev = byPeriod.get(k);
    if (!prev || f.filed < prev.filed) byPeriod.set(k, f);
  }
  const all = [...byPeriod.values()];
  const quarters = all.filter((f) => { const d = days(f.start!, f.end); return d >= 80 && d <= 100; });
  const years = all.filter((f) => { const d = days(f.start!, f.end); return d >= 350 && d <= 380 && f.form.startsWith("10-K"); });

  const archive = (accn: string) => `https://www.sec.gov/Archives/edgar/data/${Number(hit.cik)}/${accn.replace(/-/g, "")}/`;
  const period = (f: Fact, months: 3 | 12, basis: CompetitorPeriod["basis"], value = f.val, label?: string): CompetitorPeriod => ({
    months, periodStart: f.start ?? null, periodEnd: f.end,
    fiscalLabel: label ?? `FY${f.fy ?? "?"} ${months === 12 ? "FY" : f.fp ?? "?"}`,
    ...calendarPeriodOf(f.end, months),
    currency: "USD", revenue: value, basis, consolidated: true, filedDate: kstDate(secAvailableAt(f.filed)), form: f.form,
    sourceUrl: archive(f.accn), concept: `us-gaap:${best.k}`,
  });

  const out: CompetitorPeriod[] = quarters.map((f) => period(f, 3, "reported"));
  // Q4 is usually only inside the 10-K: FY minus the fiscal year's three reported quarters.
  for (const y of years) {
    out.push(period(y, 12, "reported", y.val, `FY${y.fy ?? "?"} FY`));
    const inside = quarters.filter((q) => q.start! >= y.start! && q.end <= y.end);
    const hasLast = quarters.some((q) => q.end === y.end);
    if (inside.length === 3 && !hasLast) {
      const lastEnd = inside.reduce((m, q) => (q.end > m ? q.end : m), "");
      const start = new Date(Date.parse(`${lastEnd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      out.push({ ...period({ ...y, start }, 3, "derived", y.val - inside.reduce((s, q) => s + q.val, 0), `FY${y.fy ?? "?"} Q4 (FY - Q1~Q3)`) });
    }
  }
  const q = out.filter((p) => p.months === 3).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)).slice(0, MAX_QUARTERS);
  const fy = out.filter((p) => p.months === 12).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)).slice(0, MAX_YEARS);
  if (!q.length && !fy.length) issues.push(issue("sec", "no_revenue_periods", `US:${c.ticker}: no quarterly or annual revenue periods`, "warning"));
  return {
    evidence: { market: "US", code: c.ticker, name: str(facts?.entityName) || hit.title || null, system: "SEC EDGAR", periods: [...q, ...fy].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || a.months - b.months) },
    issues,
  };
}
