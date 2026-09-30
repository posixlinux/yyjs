import type { HttpClient } from "./http.js";
import { calendarPeriodOf } from "./period.js";
import { isZip, unzip } from "./zip.js";
import type { ZipLimits } from "./zip.js";
import { CollectionError, issue } from "./types.js";
import { asRecord, str } from "./text.js";
import type { AsOf } from "./text.js";
import type { CollectionIssue, CompetitorEvidence, CompetitorPeriod } from "./types.js";

// EDINET (Japan FSA) API v2. EDINET has no company search: documents are listed per submission DATE, so we scan the
// days just before each statutory deadline (annual report: 3 months after fiscal year end; half-year report: 45 days
// after the half) backwards until the company's report shows up. Since April 2024 listed companies file half-year
// reports instead of quarterly reports, so EDINET yields fiscal-year and half-year revenue (H2 = FY - H1), never
// quarters. Revenue is read from the XBRL-to-CSV rendition (type=5) of the report itself.

const API = "https://api.edinet-fsa.go.jp/api/v2";
const CODELIST = "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip";
const VIEWER = "https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?"; // public document viewer (provenance only, never fetched)
const DAY = 86_400_000;
const ZIP: ZipLimits = { maxEntries: 200, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 };
const MAX_LIST_DAYS = 60; // date listings per company (each report found early stops its scan)
const TARGET_PERIODS = 4; // latest two fiscal years and two halves
// annual (有価証券報告書), quarterly (四半期報告書, Q2 = half-year cumulative before 2024), half-year (半期報告書)
const DOC_TYPES = new Set(["120", "140", "160"]);

export interface EdinetCtx {
  code: string; // TSE securities code, 4 characters
  asOf: AsOf;
  http: HttpClient;
  key: string;
  ttlMs: number;
}

const listOk = (buf: Buffer) => {
  try {
    const o = asRecord(JSON.parse(buf.toString("utf8")));
    return str(asRecord(o?.metadata)?.status) === "200" && Array.isArray(o?.results);
  } catch {
    return false;
  }
};

type Filer = { edinetCode: string; name: string; nameEn: string; fyEndMonth: number; domestic: boolean };
type Doc = { docID: string; edinetCode: string; docTypeCode: string; periodStart: string; periodEnd: string; submitDateTime: string; csvFlag: string; withdrawn: boolean; description: string };

/** Minimal quoted-CSV/TSV line parser (no embedded newlines; EDINET files have none). */
export function splitRow(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** "3月31日" / "2月末日" / "12月31日" -> 3 / 2 / 12. */
const fyMonth = (s: string): number => Number(/(\d{1,2})月/.exec(s.normalize("NFKC"))?.[1] ?? 0);

export function parseCodeList(csv: string): Map<string, Filer> {
  const lines = csv.split(/\r?\n/);
  const m = new Map<string, Filer>();
  // line 0: download metadata, line 1: header
  const header = splitRow(lines[1] ?? "", ",").map((h) => h.normalize("NFKC"));
  const col = (name: string) => header.indexOf(name);
  const [iCode, iKind, iFye, iName, iNameEn, iSec] = ["EDINETコード", "提出者種別", "決算日", "提出者名", "提出者名(英字)", "証券コード"].map(col);
  if ([iCode, iKind, iFye, iName, iSec].some((i) => i! < 0)) throw new CollectionError("invalid_response", "EDINET code list header changed");
  for (const line of lines.slice(2)) {
    const r = splitRow(line, ",");
    const sec = (r[iSec!] ?? "").trim();
    if (!/^[0-9A-Z]{5}$/.test(sec)) continue;
    m.set(sec.slice(0, 4), {
      edinetCode: (r[iCode!] ?? "").trim(), name: (r[iName!] ?? "").trim(), nameEn: (r[iNameEn!] ?? "").trim(),
      fyEndMonth: fyMonth(r[iFye!] ?? ""), domestic: (r[iKind!] ?? "").includes("内国法人"),
    });
  }
  return m;
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const monthEnd = (y: number, m: number) => iso(Date.UTC(y, m, 0)); // m: 1..12 (Date.UTC month m = next month, day 0)

/** Latest fiscal-year and half-year ends (newest first) whose filing window has started by asOf. */
export function targetPeriods(fyEndMonth: number, asOfDate: string): { end: string; kind: "FY" | "H1"; deadline: string }[] {
  const out: { end: string; kind: "FY" | "H1"; deadline: string }[] = [];
  const y0 = Number(asOfDate.slice(0, 4));
  for (let y = y0; y >= y0 - 3; y--) {
    for (const [kind, month] of [["FY", fyEndMonth], ["H1", ((fyEndMonth + 5) % 12) + 1]] as const) {
      const end = monthEnd(y, month);
      if (end >= asOfDate) continue;
      const deadline = iso(Date.parse(`${end}T00:00:00Z`) + (kind === "FY" ? 92 : 46) * DAY);
      out.push({ end, kind, deadline });
    }
  }
  return out.sort((a, b) => b.end.localeCompare(a.end)).slice(0, TARGET_PERIODS);
}

// Revenue elements, most specific (summary of business results) first.
const REVENUE_ELEMENTS: RegExp[] = [
  /^jpcrp_cor:(NetSales|RevenueIFRS|RevenuesUSGAAP|NetSalesIFRS|OperatingRevenue1|OperatingRevenue2|NetSalesAndOperatingRevenue)SummaryOfBusinessResults$/,
  /^jpcrp_cor:\w*(Revenue|NetSales)\w*SummaryOfBusinessResults$/,
  /^jpigp_cor:(Revenue|NetSales|SalesRevenue)\w*IFRS$/,
  /^jppfs_cor:(NetSales|OperatingRevenue1|OperatingRevenue2|NetSalesOfCompletedConstructionContracts)$/,
];

/** Revenue of the report's own period from the XBRL-to-CSV rendition (UTF-16 TSV). Consolidated preferred. */
export function revenueFromCsv(tsv: string, kind: "FY" | "H1"): { value: number; element: string; consolidated: boolean } | null {
  const rows = tsv.split(/\r?\n/).slice(1).map((l) => splitRow(l, "\t"));
  const ctx = kind === "FY" ? /^CurrentYearDuration(_NonConsolidatedMember)?$/ : /^(InterimDuration|CurrentYTDDuration)(_NonConsolidatedMember)?$/;
  for (const re of REVENUE_ELEMENTS) {
    const hits = rows.filter((r) => re.test(r[0] ?? "") && ctx.test(r[2] ?? "") && /^-?\d+$/.test((r[8] ?? "").trim()));
    const cons = hits.find((r) => !(r[2] ?? "").includes("NonConsolidated") && (r[4] ?? "") !== "個別");
    const pick = cons ?? hits[0];
    if (pick) return { value: Number(pick[8]!.trim()), element: pick[0]!, consolidated: !!cons };
  }
  return null;
}

async function listDate(c: EdinetCtx, date: string): Promise<Doc[]> {
  // A past date's listing never changes: memoised (minimal fields only) and shared by every company scanned.
  return c.http.memo(`edinet:list:${date}`, 24 * 3600_000, async () => {
    // A past day's listing is settled (only a rare withdrawal flag changes); today's is still growing.
    const past = date < new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const body = asRecord(await c.http.json(`${API}/documents.json?${new URLSearchParams({ date, type: "2", "Subscription-Key": c.key })}`,
      past ? { disk: { key: `edinet:list:${date}`, ttlMs: 30 * 86_400_000, validate: listOk } } : {}));
    const status = str(asRecord(body?.metadata)?.status) || str(body?.StatusCode);
    if (status && status !== "200") throw new CollectionError("upstream_error", `EDINET documents.json ${date} status ${status}: ${str(body?.message) || str(asRecord(body?.metadata)?.message)}`.slice(0, 300));
    const results = Array.isArray(body?.results) ? body.results : [];
    return results.map(asRecord).filter((r): r is Record<string, unknown> => !!r && DOC_TYPES.has(str(r.docTypeCode))).map((r) => ({
      docID: str(r.docID), edinetCode: str(r.edinetCode), docTypeCode: str(r.docTypeCode), periodStart: str(r.periodStart), periodEnd: str(r.periodEnd),
      submitDateTime: str(r.submitDateTime), csvFlag: str(r.csvFlag), withdrawn: str(r.withdrawalStatus) !== "0" && str(r.withdrawalStatus) !== "", description: str(r.docDescription),
    }));
  });
}

export async function collectEdinetRevenue(c: EdinetCtx): Promise<{ evidence: CompetitorEvidence | null; issues: CollectionIssue[] }> {
  const issues: CollectionIssue[] = [];
  const filers = await c.http.memo("edinet:codelist", 24 * 3600_000, async () => {
    const buf = await c.http.bytes(CODELIST, { disk: { key: "edinet:codelist", ttlMs: 86_400_000, validate: isZip } });
    if (!isZip(buf)) throw new CollectionError("invalid_response", "EDINET code list is not a ZIP");
    const file = unzip(buf, ZIP, (n) => /\.csv$/i.test(n))[0];
    if (!file) throw new CollectionError("invalid_response", "EDINET code list ZIP has no CSV");
    // The published file is Shift_JIS; a UTF-8 BOM (re-saved copies, tests) is honoured.
    const utf8 = file.data[0] === 0xef && file.data[1] === 0xbb && file.data[2] === 0xbf;
    return parseCodeList(new TextDecoder(utf8 ? "utf-8" : "shift_jis").decode(file.data));
  });
  const filer = filers.get(c.code);
  if (!filer) throw new CollectionError("ticker_not_found", `JP:${c.code} is not a listed EDINET filer`);
  if (!filer.domestic) throw new CollectionError("not_jp_domestic", `JP:${c.code} is not a domestic (Japanese) filer; only Japanese companies are compared`);
  if (filer.fyEndMonth < 1 || filer.fyEndMonth > 12) throw new CollectionError("invalid_response", `JP:${c.code}: unknown fiscal year end`);

  // Find each target report by scanning weekdays backwards from its deadline (most filings land near it).
  let listed = 0;
  const found: { kind: "FY" | "H1"; end: string; doc: Doc }[] = [];
  for (const t of targetPeriods(filer.fyEndMonth, c.asOf.dateKst)) {
    const last = t.deadline < c.asOf.dateKst ? t.deadline : c.asOf.dateKst;
    for (let d = Date.parse(`${last}T00:00:00Z`); d > Date.parse(`${t.end}T00:00:00Z`) && listed < MAX_LIST_DAYS; d -= DAY) {
      const day = new Date(d).getUTCDay();
      if (day === 0 || day === 6) continue;
      listed++;
      const docs = await listDate(c, iso(d));
      const doc = docs.find((x) => x.edinetCode === filer.edinetCode && !x.withdrawn && x.periodEnd === t.end && (t.kind === "FY" ? x.docTypeCode === "120" : x.docTypeCode !== "120"));
      if (doc) {
        found.push({ kind: t.kind, end: t.end, doc });
        break;
      }
    }
  }
  if (listed >= MAX_LIST_DAYS) issues.push(issue("edinet", "scan_budget_reached", `JP:${c.code}: stopped after ${MAX_LIST_DAYS} daily listings; older reports may be missing`, "info"));

  const periods: CompetitorPeriod[] = [];
  const got = new Map<string, { value: number; consolidated: boolean; filedDate: string }>();
  for (const f of found) {
    // submitDateTime is Japan time (UTC+9, same as KST); the listing date is never after asOf by construction.
    const filedDate = f.doc.submitDateTime.slice(0, 10);
    const submitted = Date.parse(`${f.doc.submitDateTime.replace(" ", "T")}:00+09:00`);
    if (!Number.isFinite(submitted) || submitted > c.asOf.cutoffMs) continue; // same-day filing after a timestamped asOf
    if (f.doc.csvFlag !== "1") {
      issues.push(issue("edinet", "csv_unavailable", `JP:${c.code} ${f.doc.docID}: no XBRL CSV rendition`, "warning"));
      continue;
    }
    let rev: ReturnType<typeof revenueFromCsv> = null;
    try {
      const buf = await c.http.bytes(`${API}/documents/${f.doc.docID}?${new URLSearchParams({ type: "5", "Subscription-Key": c.key })}`, {
        ttlMs: c.ttlMs, disk: { key: `edinet:document:${f.doc.docID}:csv`, ttlMs: Infinity, validate: isZip }, // a submitted document never changes
      });
      if (!isZip(buf)) throw new CollectionError("upstream_error", `EDINET document ${f.doc.docID} did not return a ZIP (${buf.toString("utf8", 0, 200)})`);
      for (const file of unzip(buf, ZIP, (n) => /XBRL_TO_CSV\/jpcrp.*\.csv$/i.test(n))) {
        rev = revenueFromCsv(new TextDecoder("utf-16le").decode(file.data), f.kind);
        if (rev) break;
      }
    } catch (e) {
      issues.push(issue("edinet", e instanceof CollectionError ? e.code : "document_failed", `JP:${c.code} ${f.doc.docID}: ${(e as Error).message}`, "warning"));
      continue;
    }
    if (!rev) {
      issues.push(issue("edinet", "revenue_not_found", `JP:${c.code} ${f.doc.docID}: no revenue element in the report`, "warning"));
      continue;
    }
    const months = f.kind === "FY" ? 12 : 6;
    // fiscal year start = day after the previous fiscal year end; a half starts on that same day
    const fyEnd = f.kind === "FY" ? f.end : monthEnd(Number(f.end.slice(0, 4)) + (Number(f.end.slice(5, 7)) + 6 > 12 ? 1 : 0), filer.fyEndMonth);
    const start = iso(Date.parse(`${monthEnd(Number(fyEnd.slice(0, 4)) - 1, filer.fyEndMonth)}T00:00:00Z`) + DAY);
    got.set(`${f.kind}|${f.end}`, { value: rev.value, consolidated: rev.consolidated, filedDate });
    periods.push({
      months, periodStart: start, periodEnd: f.end,
      fiscalLabel: `${f.kind === "FY" ? "通期" : "中間(上半期)"} ${f.end} (${f.doc.docTypeCode === "120" ? "有価証券報告書" : f.doc.docTypeCode === "160" ? "半期報告書" : "四半期報告書 Q2累計"})`,
      ...calendarPeriodOf(f.end, months),
      currency: "JPY", revenue: rev.value, basis: "reported", consolidated: rev.consolidated, filedDate,
      form: f.doc.docTypeCode === "120" ? "有価証券報告書" : f.doc.docTypeCode === "160" ? "半期報告書" : "四半期報告書",
      sourceUrl: `${VIEWER}${f.doc.docID}`, concept: rev.element,
    });
  }
  // H2 = fiscal year - the same year's first half (same consolidation basis).
  for (const p of periods.filter((x) => x.months === 12)) {
    const h1End = monthEnd(Number(p.periodEnd.slice(0, 4)) - (Number(p.periodEnd.slice(5, 7)) <= 6 ? 1 : 0), ((Number(p.periodEnd.slice(5, 7)) + 5) % 12) + 1);
    const h1 = got.get(`H1|${h1End}`);
    if (!h1 || h1.consolidated !== p.consolidated) continue;
    periods.push({
      ...p, months: 6, periodStart: iso(Date.parse(`${h1End}T00:00:00Z`) + DAY), basis: "derived",
      fiscalLabel: `下半期 ${p.periodEnd} (通期 - 中間)`, ...calendarPeriodOf(p.periodEnd, 6), revenue: p.revenue - h1.value,
    });
  }
  periods.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || a.months - b.months);
  return { evidence: { market: "JP", code: c.code, name: filer.nameEn || filer.name || null, system: "EDINET", periods }, issues };
}
