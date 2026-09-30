import type { HttpClient } from "./http.js";
import { isZip, unzip } from "./zip.js";
import type { ZipLimits } from "./zip.js";
import { classifySecurity, describeRejections } from "../domain/security.js";
import { extractDisclosureText, extractDocument, extractMetrics, extractProducts } from "./extract.js";
import { CollectionError, issue } from "./types.js";
import type {
  CollectionIssue,
  CompetitorEvidence,
  CompetitorPeriod,
  DerivedQuarter,
  DisclosureKind,
  ExchangeDisclosure,
  FilingEvidence,
  FilingPeriodType,
  MetricCandidate,
  ProductCandidate,
  StatementRow,
  StatementSet,
  TableEvidence,
  TextExcerpt,
} from "./types.js";
import { asRecord, clip, kstDate, mapLimit, parseAmount, str } from "./text.js";
import { calendarPeriodOf } from "./period.js";
import type { AsOf } from "./text.js";

const API = "https://opendart.fss.or.kr/api";
const RECEIPT = "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=";
const REPORT_CODE = { Q1: "11013", H1: "11012", Q3: "11014", FY: "11011" } as const;
const MAX_LIST_PAGES = 3;
const MAX_STATEMENT_ROWS = 400;
const MAX_METRICS = 200;
const MAX_PRODUCTS = 60;
// Exchange disclosures (pblntf_ty "I"): one newest-first list page over this window, then at most this many
// documents, fetched after the periodic filings so a tight request budget drops these first.
const DISCLOSURE_WINDOW_DAYS = 200;
const MAX_DISCLOSURE_DOCS = 4;
const DISCLOSURE_CHARS = 4000;
// report_nm (whitespace removed) -> kind, with a per-kind cap (newest first).
const DISCLOSURE_KINDS: { kind: DisclosureKind; re: RegExp; max: number }[] = [
  { kind: "earnings_schedule", re: /기업설명회|\(IR\)개최|IR개최|결산실적공시예고/, max: 2 },
  { kind: "earnings_guidance", re: /실적등에대한전망|영업실적전망/, max: 1 },
  { kind: "preliminary_earnings", re: /\(잠정\)실적|잠정실적/, max: 1 },
];

export interface DartCtx {
  ticker: string;
  asOf: AsOf;
  key: string;
  http: HttpClient;
  ttlMs: number;
  corpCodeTtlMs: number;
  documentTtlMs: number;
  maxBytes: number;
  zip: ZipLimits;
  maxFilings: number;
  maxDocuments: number;
  /** Competitor mode: statements only (no documents/disclosures) and KOSDAQ (corp_cls K) allowed. */
  competitor?: boolean;
}

export interface DartResult {
  name: string | null;
  corpCode: string | null;
  exchangeVerified: boolean;
  filings: FilingEvidence[];
  statements: StatementSet[];
  derivedQuarters: DerivedQuarter[];
  excerpts: TextExcerpt[];
  tables: TableEvidence[];
  metricCandidates: MetricCandidate[];
  productCandidates: ProductCandidate[];
  disclosures: ExchangeDisclosure[];
  issues: CollectionIssue[];
}

interface Corp {
  code: string;
  name: string;
}

// Disk-cache ages (HttpConfig.cacheDir). A filing's document never changes once received; statements are re-read
// weekly (a correction replaces them); a list whose window ends before today can only change through late
// corrections, one that includes today changes as filings arrive.
const DISK = { forever: Infinity, statement: 7 * 86_400_000, company: 7 * 86_400_000, corpCode: 86_400_000, pastList: 30 * 86_400_000, liveList: 3_600_000 };
const okJson = (buf: Buffer) => {
  try {
    return ["000", "013"].includes(str(asRecord(JSON.parse(buf.toString("utf8")))?.status));
  } catch {
    return false;
  }
};
/** List queries whose end date is before today (KST) are effectively immutable. */
const listTtl = (endDe: string) => (endDe < kstDate(Date.now()).replace(/-/g, "") ? DISK.pastList : DISK.liveList);

async function dartJson(c: DartCtx, path: string, params: Record<string, string>, noDataOk = false, diskTtlMs?: number): Promise<Record<string, unknown> | null> {
  const url = `${API}/${path}?${new URLSearchParams({ crtfc_key: c.key, ...params })}`;
  const key = `dart:${path}:${new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))}`;
  const o = asRecord(await c.http.json(url, { ttlMs: c.ttlMs, ...(diskTtlMs !== undefined && { disk: { key, ttlMs: diskTtlMs, validate: okJson } }) }));
  if (!o) throw new CollectionError("invalid_response", `DART ${path} returned a non-object`);
  const status = str(o.status);
  if (status === "000") return o;
  if (status === "013" && noDataOk) return null;
  throw new CollectionError("upstream_error", `DART ${path} status ${status || "?"}: ${clip(str(o.message), 200)}`, status === "020" || status === "800");
}

/** DART returns ZIP on success and a small XML/JSON error body (still HTTP 200) on failure. */
function dartError(buf: Buffer, what: string): CollectionError {
  const text = buf.toString("utf8", 0, 2000);
  let status = /<status>\s*(\d+)\s*<\/status>/.exec(text)?.[1];
  let message = /<message>\s*([^<]*)<\/message>/.exec(text)?.[1];
  if (!status) {
    try {
      const o = asRecord(JSON.parse(text));
      status = str(o?.status) || undefined;
      message = str(o?.message);
    } catch {
      /* not JSON */
    }
  }
  return status
    ? new CollectionError("upstream_error", `DART ${what} status ${status}: ${clip(message ?? "", 200)}`)
    : new CollectionError("invalid_response", `DART ${what} returned neither ZIP nor a DART error`);
}

async function corpIndex(c: DartCtx): Promise<Map<string, Corp>> {
  return c.http.memo("dart:corpIndex", c.corpCodeTtlMs, async () => {
    const buf = await c.http.bytes(`${API}/corpCode.xml?${new URLSearchParams({ crtfc_key: c.key })}`, { maxBytes: c.maxBytes, disk: { key: "dart:corpCode.xml", ttlMs: DISK.corpCode, validate: isZip } });
    if (!isZip(buf)) throw dartError(buf, "corpCode.xml");
    const file = unzip(buf, c.zip, (n) => /\.xml$/i.test(n))[0];
    if (!file) throw new CollectionError("invalid_response", "corpCode ZIP has no XML file");
    const xml = file.data.toString("utf8");
    const index = new Map<string, Corp>();
    for (const m of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
      const b = m[1] ?? "";
      const tag = (t: string) => new RegExp(`<${t}>\\s*([^<]*?)\\s*</${t}>`).exec(b)?.[1] ?? "";
      const stock = tag("stock_code");
      if (/^\d{6}$/.test(stock)) index.set(stock, { code: tag("corp_code"), name: tag("corp_name") });
    }
    if (index.size === 0) throw new CollectionError("invalid_response", "corpCode.xml contained no listed companies");
    return index;
  });
}

const receiptUrl = (rcept: string): string => `${RECEIPT}${rcept}`;
const isoDate = (yyyymmdd: string): string => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

function periodOf(reportName: string, fyeMonth: number): FilingEvidence["period"] | null {
  const m = /(사업|반기|분기)보고서\s*\((\d{4})\.(\d{2})\)/.exec(reportName);
  if (!m) return null;
  const year = Number(m[2]);
  const month = Number(m[3]);
  const k = (month - fyeMonth + 12) % 12; // months since fiscal year end
  const type: FilingPeriodType | null = m[1] === "사업" ? (k === 0 ? "FY" : null) : m[1] === "반기" ? (k === 6 ? "H1" : null) : k === 3 ? "Q1" : k === 9 ? "Q3" : null;
  if (!type) return null;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { type, end, fiscalYear: type === "FY" || fyeMonth === 12 ? year : year + (month > fyeMonth ? 1 : 0) };
}

export async function collectDart(c: DartCtx): Promise<DartResult> {
  const out: DartResult = {
    name: null, corpCode: null, exchangeVerified: false, filings: [], statements: [], derivedQuarters: [],
    excerpts: [], tables: [], metricCandidates: [], productCandidates: [], disclosures: [], issues: [],
  };

  const corp = (await corpIndex(c)).get(c.ticker);
  if (!corp) {
    out.issues.push(issue("dart", "corp_code_not_found", `No DART corp_code for listed ticker ${c.ticker}`));
    return out;
  }
  const company = await dartJson(c, "company.json", { corp_code: corp.code }, false, DISK.company);
  if (str(company?.stock_code) !== c.ticker) throw new CollectionError("invalid_response", "DART company stock_code does not match the ticker");
  if (!(c.competitor ? ["Y", "K"] : ["Y"]).includes(str(company?.corp_cls))) {
    out.issues.push(issue("dart", "not_kospi", `DART corp_cls is "${str(company?.corp_cls)}", not Y (KOSPI)`));
    return out;
  }
  out.exchangeVerified = true;
  out.corpCode = corp.code;
  out.name = str(company?.corp_name) || corp.name || null;
  // Common stock only. The DART corp list holds the common ticker only, but REITs/infrastructure funds/SPACs do file
  // with DART, so screen the legal name and KSIC code here (the ticker-suffix rule is applied by the caller).
  const rejections = classifySecurity({ ticker: c.ticker, names: [out.name, corp.name, str(company?.corp_name_eng)], industryCode: str(company?.induty_code), checkTickerSuffix: false });
  if (rejections.length) {
    out.issues.push(issue("dart", "not_common_stock", `Ticker ${c.ticker} (${out.name ?? "?"}) is not a common stock: ${describeRejections(rejections)}`));
    return out;
  }
  const fyeMonth = Number(str(company?.acc_mt)) || 12;

  // periodic filings up to asOf (last_reprt_at=N keeps originals + corrections; rcept_dt filters lookahead)
  const rows: Record<string, unknown>[] = [];
  const bgn = new Date(c.asOf.cutoffMs - 3 * 366 * 86400_000).toISOString().slice(0, 10).replace(/-/g, "");
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const r = await dartJson(c, "list.json", {
      corp_code: corp.code, bgn_de: bgn, end_de: c.asOf.dateKst.replace(/-/g, ""), pblntf_ty: "A",
      last_reprt_at: "N", page_no: String(page), page_count: "100", sort: "date", sort_mth: "desc",
    }, true, listTtl(c.asOf.dateKst.replace(/-/g, "")));
    if (!r) break;
    for (const x of Array.isArray(r.list) ? r.list : []) {
      const o = asRecord(x);
      if (o) rows.push(o);
    }
    if (page >= Number(str(r.total_page))) break;
  }

  const latest = new Map<string, FilingEvidence>();
  for (const o of rows) {
    const rcept = str(o.rcept_no);
    const dt = str(o.rcept_dt);
    const name = str(o.report_nm);
    if (!/^\d{14}$/.test(rcept) || !/^\d{8}$/.test(dt) || name.includes("첨부")) continue;
    // date-only asOf covers the whole day; a timestamped asOf can't order same-day filings, so exclude them
    if (isoDate(dt) > c.asOf.dateKst || (!c.asOf.dateOnly && isoDate(dt) === c.asOf.dateKst)) continue;
    const period = periodOf(name, fyeMonth);
    if (!period || period.end > c.asOf.dateKst) continue; // a period ending after asOf cannot have been reported yet
    const key = `${period.type}:${period.end}`;
    const prev = latest.get(key);
    if (prev && (prev.receivedDate > isoDate(dt) || (prev.receivedDate === isoDate(dt) && prev.rceptNo > rcept))) continue;
    latest.set(key, {
      rceptNo: rcept, receiptUrl: receiptUrl(rcept), reportName: clip(name, 200), receivedDate: isoDate(dt),
      period, isCorrection: /정정/.test(name),
    });
  }
  out.filings = [...latest.values()].sort((a, b) => b.period.end.localeCompare(a.period.end)).slice(0, Math.max(1, Math.min(8, c.maxFilings)));
  if (out.filings.length === 0) out.issues.push(issue("dart", "no_filings", "No periodic (annual/half/quarterly) filings found before asOf", "warning"));

  // Statements and documents are independent; failures are recorded per item.
  if (fyeMonth !== 12 && out.filings.length) {
    out.issues.push(issue("dart", "non_december_fiscal_year", `Fiscal year ends in month ${fyeMonth}; financial statement API mapping is only implemented for December year-ends`, "warning"));
  } else {
    const sets = await mapLimit(out.filings, 3, (f) => fetchStatement(c, corp.code, f, out.issues));
    out.statements = sets.filter((s): s is StatementSet => s !== null);
    out.derivedQuarters = deriveQ4(out.statements);
  }

  const docs = out.filings.slice(0, Math.max(0, Math.min(8, c.maxDocuments)));
  const results = await mapLimit(docs, 2, (f) => fetchDocument(c, f).then((r) => ({ f, r }), (e: unknown) => ({ f, e })));
  for (const x of results) {
    if ("e" in x) {
      out.issues.push(issue("dart", x.e instanceof CollectionError ? x.e.code : "document_failed", `Document ${x.f.rceptNo}: ${(x.e as Error).message}`));
      continue;
    }
    out.excerpts.push(...x.r.excerpts);
    out.tables.push(...x.r.tables);
    out.metricCandidates.push(...x.r.metrics);
    out.productCandidates.push(...x.r.products);
  }
  const seenMetrics = new Set<string>();
  out.metricCandidates = out.metricCandidates
    .filter((m) => {
      const k = `${m.source.rceptNo}|${m.kind}|${m.rawText}|${m.context}`;
      return !seenMetrics.has(k) && !!seenMetrics.add(k);
    })
    .slice(0, MAX_METRICS);
  out.productCandidates = dedupeProducts(out.productCandidates).slice(0, MAX_PRODUCTS);

  // Best-effort: a failure here is a warning and never costs the periodic evidence collected above.
  if (c.competitor) return out;
  try {
    out.disclosures = await collectDisclosures(c, corp.code, out.issues);
  } catch (e) {
    out.issues.push(issue("dart", e instanceof CollectionError ? e.code : "disclosures_failed", `Exchange disclosures: ${(e as Error).message}`, "warning"));
  }
  return out;
}

/** Earnings-related exchange disclosures (IR/earnings schedule, guidance, preliminary results) received by asOf. */
async function collectDisclosures(c: DartCtx, corpCode: string, issues: CollectionIssue[]): Promise<ExchangeDisclosure[]> {
  const bgn = new Date(c.asOf.cutoffMs - DISCLOSURE_WINDOW_DAYS * 86400_000).toISOString().slice(0, 10).replace(/-/g, "");
  const r = await dartJson(c, "list.json", {
    corp_code: corpCode, bgn_de: bgn, end_de: c.asOf.dateKst.replace(/-/g, ""), pblntf_ty: "I",
    last_reprt_at: "N", page_no: "1", page_count: "100", sort: "date", sort_mth: "desc",
  }, true, listTtl(c.asOf.dateKst.replace(/-/g, "")));
  const picked: Omit<ExchangeDisclosure, "text" | "truncated">[] = [];
  const perKind = new Map<DisclosureKind, number>();
  const rows = (Array.isArray(r?.list) ? r.list : []).map(asRecord).filter((o): o is Record<string, unknown> => !!o);
  rows.sort((a, b) => str(b.rcept_no).localeCompare(str(a.rcept_no))); // newest first, whatever the upstream order
  for (const o of rows) {
    if (picked.length >= MAX_DISCLOSURE_DOCS) break;
    const rcept = str(o.rcept_no);
    const dt = str(o.rcept_dt);
    const name = str(o.report_nm);
    if (!/^\d{14}$/.test(rcept) || !/^\d{8}$/.test(dt) || name.includes("첨부")) continue;
    // same lookahead rule as the periodic filings above
    if (isoDate(dt) > c.asOf.dateKst || (!c.asOf.dateOnly && isoDate(dt) === c.asOf.dateKst)) continue;
    const compact = name.replace(/\s+/g, "");
    const k = DISCLOSURE_KINDS.find((x) => x.re.test(compact));
    if (!k || (perKind.get(k.kind) ?? 0) >= k.max) continue;
    perKind.set(k.kind, (perKind.get(k.kind) ?? 0) + 1);
    picked.push({ rceptNo: rcept, receiptUrl: receiptUrl(rcept), reportName: clip(name, 200), receivedDate: isoDate(dt), kind: k.kind, isCorrection: /정정/.test(name) });
  }
  const results = await mapLimit(picked, 2, (d) => fetchDisclosureText(c, d.rceptNo).then((t) => ({ d, t }), (e: unknown) => ({ d, e })));
  const out: ExchangeDisclosure[] = [];
  for (const x of results) {
    if ("e" in x) {
      issues.push(issue("dart", x.e instanceof CollectionError ? x.e.code : "disclosure_failed", `Disclosure ${x.d.rceptNo}: ${(x.e as Error).message}`, "warning"));
      continue;
    }
    if (x.t.text.trim()) out.push({ ...x.d, ...x.t });
  }
  return out;
}

async function fetchDisclosureText(c: DartCtx, rceptNo: string): Promise<{ text: string; truncated: boolean }> {
  const buf = await c.http.bytes(`${API}/document.xml?${new URLSearchParams({ crtfc_key: c.key, rcept_no: rceptNo })}`, {
    maxBytes: c.maxBytes,
    ttlMs: c.documentTtlMs,
    disk: { key: `dart:document:${rceptNo}`, ttlMs: DISK.forever, validate: isZip },
  });
  if (!isZip(buf)) throw dartError(buf, "document.xml");
  const file = unzip(buf, c.zip, (n) => /\.(xml|html?)$/i.test(n)).sort((a, b) => a.name.localeCompare(b.name))[0];
  if (!file) throw new CollectionError("invalid_response", "disclosure ZIP has no XML/HTML file");
  return extractDisclosureText(decode(file.data), DISCLOSURE_CHARS);
}

function dedupeProducts(list: ProductCandidate[]): ProductCandidate[] {
  const seen = new Set<string>();
  return list.filter((p) => !seen.has(p.name.toLowerCase()) && !!seen.add(p.name.toLowerCase()));
}

async function fetchStatement(c: DartCtx, corpCode: string, f: FilingEvidence, issues: CollectionIssue[]): Promise<StatementSet | null> {
  const reportCode = REPORT_CODE[f.period.type];
  for (const fsDiv of ["CFS", "OFS"] as const) {
    let o: Record<string, unknown> | null;
    try {
      o = await dartJson(c, "fnlttSinglAcntAll.json", { corp_code: corpCode, bsns_year: String(f.period.fiscalYear), reprt_code: reportCode, fs_div: fsDiv }, true, DISK.statement);
    } catch (e) {
      issues.push(issue("dart", e instanceof CollectionError ? e.code : "statement_failed", `Statement ${f.period.type} ${f.period.fiscalYear} (${fsDiv}): ${(e as Error).message}`));
      return null;
    }
    const rawList = o?.list;
    const list: unknown[] = Array.isArray(rawList) ? rawList : [];
    if (!list.length) continue; // OFS only when CFS is unavailable
    // Every row must belong to the requested company/year/report/basis and to ONE receipt; otherwise the numbers
    // come from unrelated or partially restated filings and cannot share a single source receipt.
    const label = `Statement ${f.period.type} ${f.period.fiscalYear} (${fsDiv})`;
    const receipts = new Set<string>();
    for (const x of list) {
      const r = asRecord(x);
      const bad =
        !r ? "row is not an object"
        : str(r.corp_code) && str(r.corp_code) !== corpCode ? "corp_code differs"
        : str(r.bsns_year) && str(r.bsns_year) !== String(f.period.fiscalYear) ? "bsns_year differs"
        : str(r.reprt_code) && str(r.reprt_code) !== reportCode ? "reprt_code differs"
        : str(r.fs_div) && str(r.fs_div) !== fsDiv ? "fs_div differs"
        : str(r.rcept_no) && !/^\d{14}$/.test(str(r.rcept_no)) ? "malformed rcept_no"
        : "";
      if (bad) {
        issues.push(issue("dart", "statement_mismatch", `${label}: ${bad}; statement discarded`, "warning"));
        return null;
      }
      if (str(r?.rcept_no)) receipts.add(str(r?.rcept_no));
    }
    if (receipts.size > 1) {
      issues.push(issue("dart", "statement_mixed_receipts", `${label}: rows come from ${receipts.size} different receipts; statement discarded`, "warning"));
      return null;
    }
    const rcept = [...receipts][0] ?? f.rceptNo;
    if (isoDate(rcept.slice(0, 8)) > c.asOf.dateKst) {
      issues.push(issue("dart", "statement_after_asOf", `${label} was (re)filed ${isoDate(rcept.slice(0, 8))}, after asOf; excluded`, "warning"));
      return null;
    }
    const rows: StatementRow[] = [];
    for (const x of list) {
      const r = asRecord(x);
      const sj = str(r?.sj_div);
      if (!r || !["BS", "IS", "CIS", "CF"].includes(sj) || rows.length >= MAX_STATEMENT_ROWS) continue;
      rows.push({
        statement: sj as StatementRow["statement"],
        accountId: str(r.account_id),
        accountName: clip(str(r.account_nm), 200),
        currency: str(r.currency) || null,
        thisTermLabel: str(r.thstrm_nm) || null,
        thisTermAmount: parseAmount(r.thstrm_amount),
        thisTermCumulativeAmount: parseAmount(r.thstrm_add_amount),
        priorTermLabel: str(r.frmtrm_nm) || null,
        priorTermAmount: parseAmount(r.frmtrm_amount),
        priorQuarterLabel: str(r.frmtrm_q_nm) || null,
        priorQuarterAmount: parseAmount(r.frmtrm_q_amount),
        priorCumulativeAmount: parseAmount(r.frmtrm_add_amount),
      });
    }
    return {
      fiscalYear: f.period.fiscalYear, period: f.period.type, periodEnd: f.period.end, reportCode, fsDiv, rceptNo: rcept,
      receiptUrl: receiptUrl(rcept),
      thisTermCovers: f.period.type === "FY" ? "12_months" : "3_months",
      cumulativeCovers: f.period.type === "H1" ? "6_months" : f.period.type === "Q3" ? "9_months" : "none",
      amountsInCurrencyUnits: true, rows, rowsTruncated: list.length > rows.length,
    };
  }
  issues.push(issue("dart", "statement_unavailable", `No CFS/OFS statement for ${f.period.type} ${f.period.fiscalYear}`, "warning"));
  return null;
}

// Not additive across periods: per-share figures, weighted-average share counts, ratios/rates.
const NON_ADDITIVE = /PerShare|주당|WeightedAverage|가중평균|주식\s*수|NumberOf\w*Shares|률|비율|Ratio|Margin/i;
const RATE_WORD = /(?:^|[^A-Za-z])Rate\b|[a-z]Rate\b/; // case-sensitive: "IncomeTaxRate" but not "Corporate"
const nonAdditive = (s: string): boolean => NON_ADDITIVE.test(s) || RATE_WORD.test(s);
const MONEY_CODE = /^[A-Z]{3}$/;

/**
 * Q4 = annual - Q3 year-to-date, only when both come from the same fs_div and only for monetary income/expense
 * lines with the same explicit currency (a missing currency is never assumed to be money). Restatement
 * comparability between the Q3 and annual filings is NOT checked.
 */
export function deriveQ4(sets: StatementSet[]): DerivedQuarter[] {
  const out: DerivedQuarter[] = [];
  for (const fy of sets.filter((s) => s.period === "FY")) {
    const q3 = sets.find((s) => s.period === "Q3" && s.fiscalYear === fy.fiscalYear && s.fsDiv === fy.fsDiv);
    if (!q3) continue;
    const key = (r: StatementRow) => `${r.statement}|${r.accountId}|${r.accountName}`;
    const q3Rows = new Map(q3.rows.filter((r) => r.statement === "IS" || r.statement === "CIS").map((r) => [key(r), r]));
    const rows: DerivedQuarter["rows"] = [];
    for (const r of fy.rows) {
      if (r.statement !== "IS" && r.statement !== "CIS") continue;
      if (nonAdditive(`${r.accountId} ${r.accountName}`)) continue;
      const p = q3Rows.get(key(r));
      if (!p || r.thisTermAmount === null || p.thisTermCumulativeAmount === null) continue;
      if (!r.currency || !MONEY_CODE.test(r.currency) || r.currency !== p.currency) continue;
      rows.push({
        statement: r.statement, accountId: r.accountId, accountName: r.accountName, currency: r.currency,
        amount: r.thisTermAmount - p.thisTermCumulativeAmount, annualAmount: r.thisTermAmount, q3CumulativeAmount: p.thisTermCumulativeAmount,
      });
    }
    if (rows.length) {
      out.push({
        fiscalYear: fy.fiscalYear, quarter: 4, periodEnd: fy.periodEnd, fsDiv: fy.fsDiv, method: "annual_minus_q3_cumulative",
        annualRceptNo: fy.rceptNo, q3RceptNo: q3.rceptNo, verificationStatus: "derived", rows,
      });
    }
  }
  return out;
}

function decode(buf: Buffer): string {
  const head = buf.toString("latin1", 0, 200);
  const enc = /encoding=["']([\w-]+)["']/i.exec(head)?.[1]?.toLowerCase() ?? "utf-8";
  try {
    return new TextDecoder(enc).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

async function fetchDocument(c: DartCtx, f: FilingEvidence) {
  const buf = await c.http.bytes(`${API}/document.xml?${new URLSearchParams({ crtfc_key: c.key, rcept_no: f.rceptNo })}`, {
    maxBytes: c.maxBytes,
    ttlMs: c.documentTtlMs,
    disk: { key: `dart:document:${f.rceptNo}`, ttlMs: DISK.forever, validate: isZip },
  });
  if (!isZip(buf)) throw dartError(buf, "document.xml");
  const files = unzip(buf, c.zip, (n) => /\.(xml|html?)$/i.test(n)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 3);
  const excerpts: TextExcerpt[] = [];
  const tables: TableEvidence[] = [];
  const metrics: MetricCandidate[] = [];
  const products: ProductCandidate[] = [];
  for (const file of files) {
    for (const sec of extractDocument(decode(file.data))) {
      const source = { rceptNo: f.rceptNo, receiptUrl: f.receiptUrl, reportName: f.reportName, periodEnd: f.period.end, sectionTitle: sec.title };
      excerpts.push({ ...source, category: sec.category, ...(sec.financeTopic ? { financeTopic: sec.financeTopic } : {}), text: sec.text, truncated: sec.truncated });
      for (const t of sec.tables) tables.push({ ...source, category: sec.category, ...(sec.financeTopic ? { financeTopic: sec.financeTopic } : {}), ...t });
      if (sec.category === "business") {
        metrics.push(...extractMetrics(sec.text, source));
        products.push(...extractProducts(sec.title, sec.text, sec.tables, source));
      }
    }
  }
  return { excerpts, tables, metrics, products };
}

// Revenue lines, most specific first: the IFRS tag, then the usual Korean account names.
const REVENUE_ID = /^(ifrs-full|ifrs)_Revenue$/;
const REVENUE_NAME = /^(매출액|수익\(매출액\)|영업수익|매출)$/;
const revenueRow = <T extends { statement: string; accountId: string; accountName: string }>(rows: T[]): T | undefined =>
  rows.find((r) => (r.statement === "IS" || r.statement === "CIS") && REVENUE_ID.test(r.accountId)) ??
  rows.find((r) => (r.statement === "IS" || r.statement === "CIS") && REVENUE_NAME.test(r.accountName.replace(/\s+/g, "")));

/** Competitor revenue from DART: 3-month revenue of Q1/H1/Q3 reports, FY revenue, and Q4 = FY - Q3 cumulative. */
export async function collectDartRevenue(c: {
  code: string; asOf: AsOf; key: string; http: HttpClient; ttlMs: number; corpCodeTtlMs: number; zip: ZipLimits;
}): Promise<{ evidence: CompetitorEvidence | null; issues: CollectionIssue[] }> {
  const r = await collectDart({
    ticker: c.code, asOf: c.asOf, key: c.key, http: c.http, ttlMs: c.ttlMs, corpCodeTtlMs: c.corpCodeTtlMs, documentTtlMs: 0,
    maxBytes: 20 * 1024 * 1024, zip: c.zip, maxFilings: 8, maxDocuments: 0, competitor: true,
  });
  if (!r.exchangeVerified) return { evidence: null, issues: r.issues };
  const filing = new Map(r.filings.map((f) => [f.rceptNo, f]));
  const periods: CompetitorPeriod[] = [];
  for (const s of r.statements) {
    const row = revenueRow(s.rows);
    if (!row || row.thisTermAmount === null || !row.currency) continue;
    const months = s.period === "FY" ? 12 : 3;
    const f = filing.get(s.rceptNo);
    const end = s.periodEnd;
    periods.push({
      months, periodStart: null, periodEnd: end, fiscalLabel: `${s.fiscalYear} ${s.period === "FY" ? "사업보고서(연간)" : s.period === "H1" ? "반기보고서(2분기 3개월)" : `${s.period} 분기보고서`}`,
      ...calendarPeriodOf(end, months), currency: row.currency, revenue: row.thisTermAmount, basis: "reported",
      consolidated: s.fsDiv === "CFS", filedDate: f?.receivedDate ?? `${s.rceptNo.slice(0, 4)}-${s.rceptNo.slice(4, 6)}-${s.rceptNo.slice(6, 8)}`,
      form: f?.reportName ?? s.period, sourceUrl: s.receiptUrl, concept: `${row.accountName} (${row.accountId})`,
    });
  }
  for (const d of r.derivedQuarters) {
    const row = revenueRow(d.rows);
    const fy = r.statements.find((s) => s.rceptNo === d.annualRceptNo);
    if (!row || !fy) continue;
    periods.push({
      months: 3, periodStart: null, periodEnd: d.periodEnd, fiscalLabel: `${d.fiscalYear} 4분기 (연간 - 3분기 누적)`,
      ...calendarPeriodOf(d.periodEnd, 3), currency: row.currency!, revenue: row.amount, basis: "derived", consolidated: d.fsDiv === "CFS",
      filedDate: filing.get(d.annualRceptNo)?.receivedDate ?? "", form: "사업보고서 - 3분기보고서", sourceUrl: fy.receiptUrl, concept: `${row.accountName} (${row.accountId})`,
    });
  }
  periods.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || a.months - b.months);
  return { evidence: { market: "KR", code: c.code, name: r.name, system: "DART", periods }, issues: r.issues };
}
