import type { FilingEvidence, PublicEvidence, StatementSet } from "../collection/types.js";
import { seoulToday } from "../domain/time.js";
import { LIMITS, type EvidenceDocument } from "../intelligence/types.js";

// Maps collected public evidence into the bounded {id,title,url,publishedAt,text} documents the intelligence
// module accepts. URLs and dates always come from the actual source record (DART receipt + receipt date, Naver URL +
// trade/article date), never from a model. Everything here is untrusted text.

const MAX_DOCS = LIMITS.maxDocuments;
// A smaller model-facing evidence budget than LIMITS.maxTotalChars: the FULL raw collection is unaffected (kept
// intact in the PublicEvidence returned to callers / summarizeEvidence), only what is actually sent to the models is
// trimmed. Candidates are pushed onto `cands` in priority order (quote, statement, derived, filing_text/tables,
// reference, news -- see below), so cutting the total budget drops the LOWEST-priority material first: the quote/
// share proof and financial statements (which already rank IS/BS/CF within themselves via STATEMENT_ROW_BUDGET, and
// are sorted newest-period-first) survive; older filings/news are what gets omitted. Every omission/truncation is
// still reported in `omitted`/`refs[].truncated` (see summarizeEvidence), never silently dropped.
const rawEvidenceBudget = Number(process.env.INTELLIGENCE_EVIDENCE_CHAR_BUDGET);
const TOTAL_CHAR_BUDGET = Number.isFinite(rawEvidenceBudget) && rawEvidenceBudget > 0 ? Math.min(200_000, Math.max(20_000, rawEvidenceBudget)) : 90_000;
const DOC_CHAR_LIMIT = 20_000; // one document (e.g. a single large filing excerpt) must never consume the whole budget
const MAX_NEWS_DOCS = 10;
// Per-DocumentKind share of TOTAL_CHAR_BUDGET treated as a guaranteed FLOOR (not a hard ceiling -- see the two-pass
// selection in buildDocuments): without this, a ticker with many statement quarters/fsDiv combinations can fill the
// whole budget with financial statements alone before the loop ever reaches filing_text (business/product narrative)
// or reference (shares/foreign-ownership context), which is exactly the starvation observed on a real large-cap
// snapshot (quote + statements only, no business narrative, no shares proof beyond the statements). Must sum to 1.
const KIND_BUDGET_SHARE: Record<DocumentKind, number> = { quote: 0.05, statement: 0.25, derived: 0.08, disclosure: 0.05, competitor: 0.07, filing_text: 0.23, filing_tables: 0.1, reference: 0.05, news: 0.12 };
const MAX_STATEMENT_ROWS = 150;
// Per-category row budget within MAX_STATEMENT_ROWS: a large income statement must never crowd out the balance
// sheet or cash flow statement (financing/investing/CAPEX rows), which the automatic strategy path (strategy/auto.ts)
// needs for its funding/risk calculations. Rank 0 = IS/CIS, 1 = BS, 2 = CF; unused budget from one category is not
// reallocated to another, so CF/BS rows are guaranteed room even when they were collected last.
const STATEMENT_ROW_BUDGET: Record<number, number> = { 0: 80, 1: 40, 2: 30 };
const MAX_CANDIDATES_PER_FILING = 15;

export type DocumentKind = "quote" | "statement" | "derived" | "disclosure" | "competitor" | "filing_text" | "filing_tables" | "reference" | "news";

export type DocumentRef = { id: string; kind: DocumentKind; title: string; url: string; publishedAt: string; chars: number; truncated: boolean };

export type BuiltDocuments = { documents: EvidenceDocument[]; refs: DocumentRef[]; omitted: { kind: DocumentKind; reason: string; count: number }[] };

// Full source precision with thousands separators (decimals are NOT rounded: the models ground on these strings).
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 20 });
const safeId = (s: string) => s.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64);
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
/** Any ISO timestamp (UTC, +09:00, ...) -> Asia/Seoul calendar date; "" when unparseable. */
const kstDate = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : seoulToday(new Date(t));
};
export { kstDate };

type Row = StatementSet["rows"][number];
/** Money only when DART gave a currency and the account is not a per-share / share-count / ratio line. */
const isMonetary = (r: Row) =>
  !!r.currency && !/PerShare|WeightedAverage|NumberOfShares|Ratio/i.test(r.accountId) && !/주당|가중평균|주식수|비율/.test(r.accountName);

/** head = always-included context lines; byCat[0..2] = formatted IS/CIS, BS, CF row lines (already row-budgeted). */
type StatementLines = { head: string; byCat: [string[], string[], string[]] };

function stmtLines(s: StatementSet): StatementLines {
  const flow = s.thisTermCovers === "3_months" ? "해당 3개월(분기)" : "12개월(연간)";
  const cum = s.cumulativeCovers === "6_months" ? "6개월 누적" : s.cumulativeCovers === "9_months" ? "9개월 누적" : "누적";
  const head = [
    `DART 재무제표 ${s.fiscalYear} ${s.period} (${s.fsDiv === "CFS" ? "연결" : "별도"}), 기말 ${s.periodEnd}, 접수번호 ${s.rceptNo}.`,
    `통화는 행마다 표시된 값이며 원(KRW)으로 가정하지 않습니다('통화 미상'이면 화폐 금액으로 취급 금지). 소수점은 원문 그대로입니다.`,
    `해석: 손익(IS/CIS)의 화폐 항목 '당기'=${flow} 금액${s.cumulativeCovers === "none" ? "" : `, '누적'=${cum}`}. 재무상태표(BS)는 기말 시점 잔액(기간 금액 아님). 현금흐름(CF)은 공시가 제공한 기준 그대로(누적일 수 있음). 주당값·주식수·비율은 화폐 금액이 아니며 분기/누적을 단정하지 않습니다.`,
  ].join("\n");
  const rank = (r: Row) => (r.statement === "IS" || r.statement === "CIS" ? 0 : r.statement === "BS" ? 1 : 2);
  const byCategory = new Map<number, Row[]>();
  for (const r of s.rows) byCategory.set(rank(r), [...(byCategory.get(rank(r)) ?? []), r]);
  const render = (r: Row) => {
    const money = isMonetary(r);
    const unit = r.currency ? (money ? r.currency : `${r.currency}, 비화폐/주당·주식수·비율`) : "통화 미상";
    const flowRow = money && (r.statement === "IS" || r.statement === "CIS");
    const cols = [r.statement, r.accountName, r.accountId, `[${unit}]`];
    const cur = flowRow ? `당기(${flow}` : r.statement === "BS" ? "기말 잔액(시점" : r.statement === "CF" ? "당기(공시 제공 기준" : "당기 값(기간 성격 미확인";
    if (r.thisTermAmount !== null) cols.push(`${cur}${r.thisTermLabel ? `, ${r.thisTermLabel}` : ""}): ${fmt(r.thisTermAmount)}`);
    if (r.thisTermCumulativeAmount !== null) cols.push(`누적${flowRow ? `(${cum})` : ""}: ${fmt(r.thisTermCumulativeAmount)}`);
    if (r.priorTermAmount !== null) cols.push(`전기${r.priorTermLabel ? `(${r.priorTermLabel})` : ""}: ${fmt(r.priorTermAmount)}`);
    if (r.priorQuarterAmount !== null) cols.push(`전년 동분기${r.priorQuarterLabel ? `(${r.priorQuarterLabel})` : ""}: ${fmt(r.priorQuarterAmount)}`);
    if (r.priorCumulativeAmount !== null) cols.push(`전기 누적: ${fmt(r.priorCumulativeAmount)}`);
    return cols.join(" | ");
  };
  // DART commonly lists investing/financing details after dozens of operating adjustments. Keep the funding
  // inputs before applying either the row or character cap, not merely a quota for the CF category as a whole.
  const fundingPriority = (r: Row) => /현금및현금성|현금및예금|사용.*제한|차입|사채|유동성장기|감가상각|상각비|유형자산.*취득|무형자산.*취득|운전자본|매출채권|재고자산|매입채무|법인세.*(납부|지급)|이자.*지급|배당.*지급|자기주식.*취득|CashAndCashEquivalents|Borrowings|Repayments|Depreciation|Amortisation|PurchaseOfProperty|PurchaseOfIntangible|InterestPaid|IncomeTaxesPaid|DividendsPaid/i.test(`${r.accountName} ${r.accountId}`) ? 0 : 1;
  const cat = (k: number) => (byCategory.get(k) ?? [])
    .sort((a, b) => k === 0 ? 0 : fundingPriority(a) - fundingPriority(b))
    .slice(0, STATEMENT_ROW_BUDGET[k]).map(render);
  const byCat: [string[], string[], string[]] = [cat(0), cat(1), cat(2)];
  const total = byCat[0].length + byCat[1].length + byCat[2].length;
  if (total > MAX_STATEMENT_ROWS) byCat[0] = byCat[0].slice(0, Math.max(0, MAX_STATEMENT_ROWS - byCat[1].length - byCat[2].length));
  return { head, byCat };
}

const stmtFullText = (sl: StatementLines): string => [sl.head, ...sl.byCat.flat()].join("\n");

/** Truncates a statement document to `limit` chars, keeping the head (truncated too, if `limit` is smaller than it)
 * and giving each nonempty IS/BS/CF category a fair, equal share of the remaining budget -- via water-filling so a
 * category with less content than its share releases the rest to the others -- before falling back to a blind
 * tail-cut for whatever wildly exceeds the doc limit. This protects both ends: a large income statement can no
 * longer starve CF/BS (or vice versa, as the old CF-then-BS-then-IS fill order could fully starve IS), and the head
 * itself is now bounded so a `limit` smaller than the head can never make the returned text exceed `limit`. Row
 * COUNT is already bounded by STATEMENT_ROW_BUDGET, but that alone does not bound character length. */
function truncateStatement(sl: StatementLines, limit: number): { text: string; truncated: boolean } {
  const full = stmtFullText(sl);
  if (full.length <= limit) return { text: full, truncated: false };
  const marker = "\n[TRUNCATED]";
  const maxHead = Math.max(0, limit - marker.length);
  const head = sl.head.length <= maxHead ? sl.head : sl.head.slice(0, maxHead);
  const rowBudget = Math.max(0, limit - head.length - marker.length);

  // Water-filling: split rowBudget equally across nonempty categories, then repeatedly settle any category whose
  // full content costs less than its current equal share, redistributing the leftover across the still-unsettled
  // categories, until every remaining category is capped at (and will use up to) an equal share of what's left.
  const nonEmpty = ([0, 1, 2] as const).filter((c) => sl.byCat[c].length > 0);
  const shareBudget = new Map<number, number>();
  {
    const remaining = new Set<number>(nonEmpty);
    let leftover = rowBudget;
    while (remaining.size > 0) {
      const share = leftover / remaining.size;
      let settledAny = false;
      for (const c of [...remaining]) {
        const demand = sl.byCat[c].reduce((s, l) => s + l.length + 1, 0);
        if (demand <= share) {
          shareBudget.set(c, demand);
          leftover -= demand;
          remaining.delete(c);
          settledAny = true;
        }
      }
      if (!settledAny) {
        for (const c of remaining) shareBudget.set(c, share);
        break;
      }
    }
  }

  const kept: [string[], string[], string[]] = [[], [], []];
  for (const c of nonEmpty) {
    let budget = shareBudget.get(c) ?? 0;
    for (const line of sl.byCat[c]) {
      const cost = line.length + 1; // + newline
      if (cost > budget) continue; // this row doesn't fit its category's share; a shorter row still might
      kept[c].push(line);
      budget -= cost;
    }
  }
  const orderedLines = [0, 1, 2].flatMap((c) => kept[c as 0 | 1 | 2]);
  const text = [head, ...orderedLines].join("\n") + marker;
  // Defensive: the budgeting above already keeps text.length <= limit by construction; slice as a hard backstop.
  return { text: text.length <= limit ? text : text.slice(0, limit), truncated: true };
}
export { truncateStatement };

type CategoryKey = "business" | "shares" | "finance";
const CATEGORY_ORDER: readonly CategoryKey[] = ["business", "shares", "finance"];
const CATEGORY_LABEL: Record<CategoryKey, string> = { business: "사업", shares: "주식/지분", finance: "재무" };
/** Excerpts/tables without a category (older data, or sections the extractor didn't classify) default to "business"
 * rather than being dropped or silently merged into whichever category happens to render first. */
const catOf = (e: { category?: string }): CategoryKey => (e.category === "shares" || e.category === "finance" ? e.category : "business");

/** Joins per-category text blocks (each block = one excerpt or table, already labelled with its source section) into
 * a single document, and -- only when the joined text exceeds `limit` -- gives each nonempty category a fair, equal
 * share of the budget via the same water-filling used for statement rows, so a flood of "business" narrative can
 * never starve "shares"/"finance" blocks (or vice versa) within the same filing. Omitted blocks are called out with
 * an explicit marker rather than silently dropped. */
function truncateCategorized(byCat: Partial<Record<CategoryKey, string[]>>, limit: number): { text: string; truncated: boolean } {
  const sep = "\n\n";
  const join = (blocks: string[]) => blocks.join(sep);
  const full = join(CATEGORY_ORDER.flatMap((c) => byCat[c] ?? []));
  if (full.length <= limit) return { text: full, truncated: false };
  const marker = "\n[TRUNCATED: 일부 항목(구간) 생략됨]";
  const nonEmpty = CATEGORY_ORDER.filter((c) => (byCat[c] ?? []).length > 0);
  const budgetTotal = Math.max(0, limit - marker.length - Math.max(0, nonEmpty.length - 1) * sep.length);

  const shareBudget = new Map<CategoryKey, number>();
  {
    const remaining = new Set<CategoryKey>(nonEmpty);
    let leftover = budgetTotal;
    while (remaining.size > 0) {
      const share = leftover / remaining.size;
      let settledAny = false;
      for (const c of [...remaining]) {
        const blocks = byCat[c] ?? [];
        const demand = blocks.reduce((s, b, i) => s + b.length + (i > 0 ? sep.length : 0), 0);
        if (demand <= share) {
          shareBudget.set(c, demand);
          leftover -= demand;
          remaining.delete(c);
          settledAny = true;
        }
      }
      if (!settledAny) {
        for (const c of remaining) shareBudget.set(c, share);
        break;
      }
    }
  }

  const kept: Partial<Record<CategoryKey, string[]>> = {};
  let omittedAny = false;
  for (const c of nonEmpty) {
    const blocks = byCat[c] ?? [];
    let budget = shareBudget.get(c) ?? 0;
    const keptBlocks: string[] = [];
    for (const b of blocks) {
      const cost = b.length + (keptBlocks.length > 0 ? sep.length : 0);
      if (cost > budget) { omittedAny = true; continue; } // this block doesn't fit its category's share; a shorter one still might
      keptBlocks.push(b);
      budget -= cost;
    }
    if (keptBlocks.length) kept[c] = keptBlocks;
  }
  const text = join(CATEGORY_ORDER.flatMap((c) => kept[c] ?? [])) + (omittedAny ? marker : "");
  return { text: text.length <= limit ? text : text.slice(0, limit), truncated: true };
}

const PRODUCT_MARKET_WORDS = ["시장", "점유율", "점유", "성장", "전망", "가이던스", "업황", "출하", "수요", "제품", "판매", "매출", "시황", "가격", "공급"];
const coverageScore = (text: string) => PRODUCT_MARKET_WORDS.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);

export function buildDocuments(ev: PublicEvidence): BuiltDocuments {
  const filings = new Map<string, FilingEvidence>(ev.filings.list.map((f) => [f.rceptNo, f]));
  type Truncator = (limit: number) => { text: string; truncated: boolean };
  type Candidate = { kind: DocumentKind; doc: EvidenceDocument; truncate?: Truncator };
  const cands: Candidate[] = [];
  const add = (kind: DocumentKind, id: string, title: string, url: string, publishedAt: string, text: string, truncate?: Truncator) => {
    if (!text.trim() || !isDate(publishedAt) || !/^https?:\/\//.test(url)) return; // unattributable text is never shown to a model
    cands.push({ kind, doc: { id: safeId(id), title: title.slice(0, 300), url: url.slice(0, 500), publishedAt, text }, truncate });
  };

  const q = ev.market.quote;
  if (q)
    add(
      "quote",
      "naver-quote",
      `Naver 증권 시세 스냅샷 ${q.ticker}`,
      q.sourceUrl,
      kstDate(q.tradedAt),
      `종목 ${q.name} (${q.ticker}), 시장 ${q.exchange.name || q.exchange.nameEng}. 종가(최근 체결가) ${fmt(q.close)} 원 (${q.currency}), 체결 시각 ${q.tradedAt}. 최신 스냅샷이며 과거 종가 조회가 아닙니다.`,
    );

  // Share totals and FX rates are core per-share / currency facts: they ride with the quote (same priority).
  const SHARE_KIND = { common: "보통주", preferred: "우선주·종류주", total: "합계", other: "기타" } as const;
  for (const sc of ev.filings.shareCounts ?? []) {
    const n = (v: number | null) => (v === null ? "-" : `${fmt(v)}주`);
    add(
      "quote",
      `shr-${sc.rceptNo}`,
      `DART 주식의 총수 현황 ${sc.fiscalYear} ${sc.period}`,
      sc.receiptUrl,
      sc.receivedDate,
      [
        `DART 주식의 총수 현황 (${sc.fiscalYear} ${sc.period}, 기준일 ${sc.periodEnd}, 접수번호 ${sc.rceptNo}). 단위: 주.`,
        "유통주식수 = 발행주식총수 - 자기주식수. 희석 가중평균 보통주식수가 아니며, 희석성 증권이 없을 때만 같습니다. 우선주는 보통주 수에 넣지 마세요.",
        ...sc.classes.map((c) => `${c.label} [${SHARE_KIND[c.kind]}] | 발행주식총수 ${n(c.issued)} | 자기주식수 ${n(c.treasury)} | 유통주식수 ${n(c.outstanding)}`),
      ].join("\n"),
    );
  }
  const fx = ev.market.fxRates ?? [];
  if (fx.length)
    add(
      "quote",
      `fx-ecb-${fx[0]!.rateDate}`,
      `ECB 기준환율 (원화 환산) ${fx[0]!.rateDate}`,
      fx[0]!.sourceUrl,
      fx[0]!.rateDate,
      [
        `ECB 유로 기준환율 ${fx[0]!.rateDate}자(Frankfurter API 제공)를 유로 경유로 원화 환산한 값입니다. 1 통화 단위당 원(KRW).`,
        ...fx.map((f) => `${f.currency}/KRW: 1 ${f.currency} = ${fmt(f.krwPerUnit)} KRW`),
      ].join("\n"),
    );

  [...ev.filings.statements]
    .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1))
    .forEach((s) => {
      const f = filings.get(s.rceptNo);
      if (!f) return;
      const sl = stmtLines(s);
      add("statement", `stmt-${s.rceptNo}-${s.fsDiv}`, `DART 재무제표 ${s.fiscalYear} ${s.period} ${s.fsDiv}`, f.receiptUrl, f.receivedDate, stmtFullText(sl), (limit) => truncateStatement(sl, limit));
    });

  for (const d of ev.filings.derivedQuarters) {
    const annual = filings.get(d.annualRceptNo);
    const q3 = filings.get(d.q3RceptNo);
    if (!annual || !q3) continue;
    // A Q3 (re)filed after the annual report (a correction) makes annual-vs-Q3 comparability unknown: withhold.
    if (q3.receivedDate > annual.receivedDate || q3.isCorrection || annual.isCorrection) continue;
    const lines = d.rows
      .filter((r) => !!r.currency)
      .map((r) => `${r.statement} | ${r.accountName} [${r.currency}]: 4분기(3개월) ${fmt(r.amount)} = 연간 ${fmt(r.annualAmount)} - 3분기 누적 ${fmt(r.q3CumulativeAmount)}`);
    add(
      "derived",
      `drv-${d.fiscalYear}Q4-${d.fsDiv}`,
      `DART 파생 4분기 ${d.fiscalYear} (연간 - 3분기 누적, ${d.fsDiv})`,
      annual.receiptUrl, // the document's own receipt/date are the ANNUAL filing's; the Q3 source is named in the text
      annual.receivedDate,
      [
        `파생값(직접 공시 아님): ${d.fiscalYear}년 4분기 = 사업보고서 연간 - 3분기보고서 누적 (통화는 행별 표시).`,
        `연간 사업보고서: 접수번호 ${annual.rceptNo}, 접수일 ${annual.receivedDate}, ${annual.receiptUrl}`,
        `3분기보고서: 접수번호 ${q3.rceptNo}, 접수일 ${q3.receivedDate}, ${q3.receiptUrl}`,
        ...lines,
      ].join("\n"),
    );
  }

  // Exchange disclosures (short; the strategy call's catalyst / guidance / preliminary-results evidence). The DART
  // receipt URL and receipt date are the document's own, so a catalyst citing one resolves to a real source.
  const DISCLOSURE_LABEL = { earnings_schedule: "실적발표·IR 일정", earnings_guidance: "회사 실적 전망(가이던스)", preliminary_earnings: "잠정 실적" } as const;
  for (const d of ev.filings.disclosures ?? []) {
    add(
      "disclosure",
      `dsc-${d.rceptNo}`,
      `DART 거래소 공시 - ${d.reportName}`,
      d.receiptUrl,
      d.receivedDate,
      `[거래소 공시 · ${DISCLOSURE_LABEL[d.kind]} · 회사 자체 공시이며 애널리스트 컨센서스가 아님] ${d.reportName} (접수일 ${d.receivedDate}, 접수번호 ${d.rceptNo})${d.truncated ? " [일부 잘림]" : ""}\n${d.text}`,
    );
  }

  // Competitors (KR/US/JP filings): one document per company. The document's url/date are its NEWEST filing's; every
  // period line names its own filing, so a cited value is traceable. Values are as filed (currency, whole company).
  const MONTHS = { 3: "3개월(분기)", 6: "6개월(반기)", 12: "12개월(연간)" } as const;
  for (const c of ev.competitors ?? []) {
    const newest = [...c.periods].sort((a, b) => b.filedDate.localeCompare(a.filedDate))[0];
    if (!newest) continue;
    const lines = c.periods.map((p) =>
      [
        `${p.calendarPeriod}${p.calendarAlignment === "exact" ? "" : "(근사)"} · ${MONTHS[p.months]} · 회계 ${p.fiscalLabel}${p.periodStart ? ` (${p.periodStart}~${p.periodEnd})` : ` (기말 ${p.periodEnd})`}`,
        `[${p.currency}] 매출 ${fmt(p.revenue)}${p.basis === "derived" ? " (파생값: 연간 - 같은 회계연도 다른 기간)" : ""}`,
        `${p.consolidated === false ? "별도/개별" : "연결"} · ${p.form} 공시 ${p.filedDate} · ${p.sourceUrl}`,
      ].join(" | "),
    );
    add(
      "competitor",
      `cmp-${c.market}-${c.code}`,
      `[경쟁사 공시 매출 · ${c.market}] ${c.name ?? c.code} (${c.system})`,
      newest.sourceUrl,
      newest.filedDate,
      [
        `[경쟁사 공시 매출 · ${c.system} · ${c.market === "KR" ? "한국" : c.market === "US" ? "미국" : "일본"}] ${c.name ?? ""} (${c.market}:${c.code}). 공시 원문 수치 그대로이며 환산·단위 변환 없음(금액은 통화 1단위 기준).`,
        "해석: 회사 전체 매출이며 특정 제품 시장 매출이 아닙니다. 회계 기간은 달력 분기(예 2026Q2)나 달력 분기 범위(반기·연간, 예 2025Q2~2025Q3)로 표시했고 '(근사)'는 기말이 달력 기간 말과 7일 넘게 다른 경우입니다." +
          (c.market === "JP" ? " 일본 기업은 2024년 이후 분기보고서가 없어 반기·연간 수치만 있습니다." : ""),
        ...lines,
      ].join("\n"),
    );
  }

  const byFiling = <T extends { rceptNo: string }>(items: T[]) => {
    const m = new Map<string, T[]>();
    for (const i of items) m.set(i.rceptNo, [...(m.get(i.rceptNo) ?? []), i]);
    return [...m.entries()].sort((a, b) => ((filings.get(b[0])?.period.end ?? "") > (filings.get(a[0])?.period.end ?? "") ? 1 : -1));
  };
  for (const [rcept, excerpts] of byFiling(ev.filings.excerpts)) {
    const f = filings.get(rcept);
    if (!f) continue;
    const byCat: Partial<Record<CategoryKey, string[]>> = {};
    for (const e of excerpts) {
      const cat = catOf(e);
      const block = `## [${CATEGORY_LABEL[cat]}] ${e.sectionTitle} (기간말 ${e.periodEnd})${e.truncated ? " [발췌 일부 잘림]" : ""}\n${e.text}`;
      (byCat[cat] ??= []).push(block);
    }
    const ms = ev.filings.metricCandidates.filter((m) => m.source.rceptNo === rcept).slice(0, MAX_CANDIDATES_PER_FILING);
    const ps = ev.filings.productCandidates.filter((p) => p.source.rceptNo === rcept).slice(0, MAX_CANDIDATES_PER_FILING);
    if (ms.length || ps.length)
      (byCat.business ??= []).push(
        `## [${CATEGORY_LABEL.business}] 자동 추출 후보 (미검증, 원문 구절 그대로)\n` +
          [...ms.map((m) => `[${m.kind}/${m.measure ?? "n/a"}/${m.basis}] ${m.rawText}`), ...ps.map((p) => `[제품 후보] ${p.name}`)].join("\n"),
      );
    const fullText = CATEGORY_ORDER.flatMap((c) => byCat[c] ?? []).join("\n\n");
    add("filing_text", `exc-${rcept}`, `DART ${f.reportName} - 사업의 내용 발췌`, f.receiptUrl, f.receivedDate, fullText, (limit) => truncateCategorized(byCat, limit));
  }
  for (const [rcept, tables] of byFiling(ev.filings.tables)) {
    const f = filings.get(rcept);
    if (!f) continue;
    const byCat: Partial<Record<CategoryKey, string[]>> = {};
    for (const t of tables) {
      const cat = catOf(t);
      const block = `## [${CATEGORY_LABEL[cat]}] ${t.sectionTitle} [단위: ${t.unit ?? "미상"}]${t.truncated ? " [표 일부 잘림]" : ""}\n${t.text}`;
      (byCat[cat] ??= []).push(block);
    }
    const fullText = CATEGORY_ORDER.flatMap((c) => byCat[c] ?? []).join("\n\n");
    add("filing_tables", `tbl-${rcept}`, `DART ${f.reportName} - 표`, f.receiptUrl, f.receivedDate, fullText, (limit) => truncateCategorized(byCat, limit));
  }

  if (ev.market.referenceMetrics.length) {
    const first = ev.market.referenceMetrics[0]!;
    add(
      "reference",
      "naver-reference",
      `Naver 증권 참고 지표 ${ev.ticker}`,
      first.sourceUrl,
      kstDate(first.retrievedAt),
      "참고 지표(모델 입력 아님; 제품 시장·희석 주식수 근거로 사용 금지):\n" +
        ev.market.referenceMetrics.slice(0, 20).map((m) => `${m.label}: ${m.rawValue}${m.rawDescription ? ` (${m.rawDescription})` : ""} [${m.role}]`).join("\n"),
    );
  }

  const per = ev.market.perReference;
  if (per)
    add(
      "reference",
      "naver-per-band",
      `PER 참고 범위 ${ev.ticker} (Naver 시세·분기 EPS로 계산)`,
      per.sourceUrls[0]!,
      per.latestClose.date,
      [
        "참고값(모델 가정의 근거일 뿐 관측된 PER 시계열이 아님). Naver 일별 종가와 분기 실적 EPS(기준 미확인)로 서버가 계산했습니다.",
        `최근 4개 분기 EPS 합(TTM) ${fmt(per.ttmEpsKRW)} 원 (${per.quarters.join(", ")}). 최근 종가 ${fmt(per.latestClose.closeKRW)} 원 (${per.latestClose.date}) → 후행 PER ${fmt(per.current)}배.`,
        `${per.window.from}~${per.window.to} ${per.window.sessions}거래일 종가를 같은 TTM EPS로 나눈 범위: 최저 ${fmt(per.window.min)}배, 중앙 ${fmt(per.window.median)}배, 최고 ${fmt(per.window.max)}배.`,
      ].join("\n"),
    );
  const annual = ev.market.annualFinance ?? [];
  if (annual.length) {
    const won = (v: number | null) => (v === null ? "-" : `${fmt(v)} 원`);
    const lines = annual.map((a, i) => {
      const prev = annual[i - 1];
      const g = prev?.revenueKRW && a.revenueKRW !== null ? ` (매출 전년 대비 ${fmt(Math.round((a.revenueKRW / prev.revenueKRW - 1) * 1000) / 10)}%)` : "";
      return `${a.period} ${a.isConsensus ? "[컨센서스]" : "[실적]"} 매출액 ${won(a.revenueKRW)} | 영업이익 ${won(a.operatingProfitKRW)} | 당기순이익 ${won(a.netIncomeKRW)} | EPS ${a.epsKRW === null ? "-" : `${fmt(a.epsKRW)} 원`}${g}`;
    });
    add(
      "reference",
      "naver-annual",
      `Naver 연간 실적·컨센서스 ${ev.ticker}`,
      annual[0]!.sourceUrl,
      kstDate(annual[0]!.observedAt),
      "회사 전체 연간 실적과 증권사 컨센서스(Naver 표시 기준, 억원을 원으로 환산). 회사 매출 성장의 참고값이며 제품 시장 규모나 시장 성장률이 아닙니다.\n" + lines.join("\n"),
    );
  }

  // Articles that actually discuss products/markets first (then newest), not just generic current stock news.
  const newsBody = (n: PublicEvidence["market"]["news"][number]) => (n.articleText ? n.articleText : n.snippet);
  const news = [...ev.market.news, ...ev.market.searchNews]
    .map((n) => ({ n, score: coverageScore(`${n.title} ${newsBody(n)}`) }))
    .sort((a, b) => b.score - a.score || (a.n.publishedAt < b.n.publishedAt ? 1 : -1));
  const seenNews = new Set<string>();
  for (const { n } of news) {
    if (seenNews.has(n.url)) continue;
    seenNews.add(n.url);
    const fetched = !!n.articleText;
    add(
      "news",
      `news-${n.origin === "naver-search" ? "s" : "n"}-${n.id}`,
      `[뉴스 ${fetched ? "기사 본문" : "스니펫"}] ${n.title}`,
      n.url,
      kstDate(n.publishedAt),
      `[언론 보도 ${fetched ? `- 기사 본문 발췌${n.articleTruncated ? "(잘림)" : ""}` : "- 짧은 스니펫만 확보"}; 검증되지 않은 보도이며 그 자체로 예측 근거가 아님]\n${n.title}\n${newsBody(n)}${n.officeName ? `\n(${n.officeName})` : ""}`,
    );
  }

  // Apply the caps in priority order (already sorted by kind above): count, news cap, character budget (per-kind
  // reservation first, then any leftover -- see KIND_BUDGET_SHARE above).
  const documents: EvidenceDocument[] = [];
  const refs: DocumentRef[] = [];
  const omitted = new Map<string, { kind: DocumentKind; reason: string; count: number }>();
  const skip = (kind: DocumentKind, reason: string) => {
    const k = `${kind}:${reason}`;
    omitted.set(k, { kind, reason, count: (omitted.get(k)?.count ?? 0) + 1 });
  };
  let chars = 0;
  let newsDocs = 0;
  const ids = new Set<string>();
  const kindChars: Partial<Record<DocumentKind, number>> = {};

  const admit = (c: Candidate, limit: number) => {
    const { kind, doc, truncate } = c;
    let truncated: boolean;
    let text: string;
    if (doc.text.length > limit && truncate) ({ text, truncated } = truncate(limit));
    else {
      truncated = doc.text.length > limit;
      text = truncated ? `${doc.text.slice(0, limit - 14)}\n[TRUNCATED]` : doc.text;
    }
    ids.add(doc.id);
    chars += text.length;
    kindChars[kind] = (kindChars[kind] ?? 0) + text.length;
    if (kind === "news") newsDocs++;
    documents.push({ ...doc, text });
    refs.push({ id: doc.id, kind, title: doc.title, url: doc.url, publishedAt: doc.publishedAt, chars: text.length, truncated });
  };

  // Pass 1: admit within BOTH the per-kind reservation and the overall budget, so a flood of one class (e.g. many
  // statement quarters/fsDiv combinations) cannot starve the others. Anything that would exceed the per-kind cap is
  // deferred (not dropped) so leftover total budget can still reach it in pass 2.
  const deferred: Candidate[] = [];
  for (const c of cands) {
    if (ids.has(c.doc.id)) continue;
    if (documents.length >= MAX_DOCS) { skip(c.kind, "document_count_cap"); continue; }
    if (c.kind === "news" && newsDocs >= MAX_NEWS_DOCS) { skip(c.kind, "news_cap"); continue; }
    const kindRoom = TOTAL_CHAR_BUDGET * KIND_BUDGET_SHARE[c.kind] - (kindChars[c.kind] ?? 0);
    const room = Math.min(TOTAL_CHAR_BUDGET - chars, kindRoom);
    if (room < 200) { deferred.push(c); continue; }
    admit(c, Math.min(DOC_CHAR_LIMIT, room));
  }
  // Pass 2: spend any budget left over (kinds that used less than their reservation) on deferred candidates, in the
  // same priority order, ignoring the per-kind cap -- it is a guaranteed floor, not a hard ceiling.
  for (const c of deferred) {
    if (ids.has(c.doc.id)) continue;
    if (documents.length >= MAX_DOCS) { skip(c.kind, "document_count_cap"); continue; }
    if (c.kind === "news" && newsDocs >= MAX_NEWS_DOCS) { skip(c.kind, "news_cap"); continue; }
    const room = TOTAL_CHAR_BUDGET - chars;
    if (room < 200) { skip(c.kind, "character_budget"); continue; }
    admit(c, Math.min(DOC_CHAR_LIMIT, room));
  }
  return { documents, refs, omitted: [...omitted.values()] };
}

/** Compact, bounded description of the evidence for job results (full texts stay out of the response). */
export function summarizeEvidence(ev: PublicEvidence, built: BuiltDocuments) {
  return {
    schemaVersion: ev.schemaVersion,
    status: ev.status,
    ticker: ev.ticker,
    asOf: ev.asOf,
    collectedAt: ev.collectedAt,
    modelReady: ev.modelReady,
    untrustedContentNotice: ev.untrustedContentNotice,
    providers: ev.providers,
    issues: ev.issues,
    company: ev.company,
    quote: ev.market.quote,
    referenceMetricCount: ev.market.referenceMetrics.length,
    quarterlyConsensus: ev.market.quarterlyConsensus ?? [],
    annualFinance: ev.market.annualFinance ?? [],
    perReference: ev.market.perReference ?? null,
    fxRates: ev.market.fxRates ?? [],
    news: [...ev.market.news, ...ev.market.searchNews].slice(0, 30).map((n) => ({ title: n.title, url: n.url, publishedAt: n.publishedAt, origin: n.origin, officeName: n.officeName })),
    filings: {
      list: ev.filings.list,
      statements: ev.filings.statements.map((s) => ({ fiscalYear: s.fiscalYear, period: s.period, periodEnd: s.periodEnd, fsDiv: s.fsDiv, rceptNo: s.rceptNo, receiptUrl: s.receiptUrl, rows: s.rows.length })),
      derivedQuarters: ev.filings.derivedQuarters.map((d) => ({ fiscalYear: d.fiscalYear, quarter: d.quarter, fsDiv: d.fsDiv, method: d.method })),
      excerptSections: ev.filings.excerpts.map((e) => ({ rceptNo: e.rceptNo, receiptUrl: e.receiptUrl, sectionTitle: e.sectionTitle, chars: e.text.length })),
      shareCounts: ev.filings.shareCounts ?? [],
      productCandidates: ev.filings.productCandidates.slice(0, 40),
      metricCandidates: ev.filings.metricCandidates.slice(0, 40),
    },
    competitors: (ev.competitors ?? []).map((c) => ({
      market: c.market, code: c.code, name: c.name, system: c.system,
      periods: c.periods.map((p) => ({ calendarPeriod: p.calendarPeriod, months: p.months, currency: p.currency, revenue: p.revenue, basis: p.basis, filedDate: p.filedDate, sourceUrl: p.sourceUrl })),
    })),
    requiredInputs: ev.requiredInputs,
    documents: { sentToModels: built.refs, omitted: built.omitted },
  };
}
