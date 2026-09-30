import type { ExcerptCategory, FinanceTopic, MetricCandidate, ProductCandidate, SourceLocator } from "./types.js";
import { clip, collapse, decodeEntities, plainText } from "./text.js";

const SECTION_CHARS = 6000;
const TABLE_CHARS = 4000;
const TABLE_ROWS = 80;

/** Headings whose sections carry business / product / market information. */
const TARGET = /사업의\s*(내용|개요)|주요\s*(제품|상품|서비스)|제품.*서비스|매출\s*(및|과)?\s*수주|매출\s*(실적|현황|구성)|시장\s*(점유|규모|현황|의\s*특성)|산업의\s*(특성|현황)|시장점유|경쟁|사업\s*부문|신규\s*사업|판매\s*(현황|조직)?/;
/** Headings carrying share counts / EPS / capital structure that valuation per share depends on. */
const SHARES_TARGET = /주식의\s*총수|발행\s*(할\s*)?주식|주당\s*(순?이익|순?손익|이익|손실)|기본\s*주당|희석|자본금|우선주|비지배\s*지분|자기\s*주식|주식\s*수/;
const PRODUCT_SECTION = /제품|상품|서비스|매출|사업\s*부문|사업의\s*개요/;
const TOP_HEADING = /^(?:[IVX]+)\.\s/;

/** Headings for each investing/financing-side note that strategy/auto.ts funding-risk logic reads. */
const FINANCE_TOPIC_PATTERNS: Record<FinanceTopic, RegExp> = {
  investments: /타법인\s*(출자|투자)|출자\s*현황|투자\s*현황/,
  capex: /시설\s*투자|자본적\s*지출|설비\s*투자|투자\s*계획|CAPEX/i,
  debtMaturities: /차입금\s*(만기|현황)|만기\s*(도래|구조|일정)|상환\s*일정|채무\s*만기/,
  cashflow: /현금\s*흐름(표)?/,
  committedFinancing: /약정\s*(한도|현황)|신용\s*한도|한도\s*대출|미사용\s*(약정|한도)|자금\s*조달\s*계획/,
  restrictedCash: /사용\s*(이\s*)?제한.{0,6}(예금|현금)|제한\s*된?\s*(예금|현금)/,
};
const FINANCE_TOPICS = Object.keys(FINANCE_TOPIC_PATTERNS) as FinanceTopic[];
const FINANCE_TARGET = new RegExp(FINANCE_TOPICS.map((k) => FINANCE_TOPIC_PATTERNS[k].source).join("|"), "i");

function financeTopicOf(title: string): FinanceTopic | null {
  for (const k of FINANCE_TOPICS) if (FINANCE_TOPIC_PATTERNS[k].test(title)) return k;
  return null;
}

interface CategoryBudget {
  sections: number;
  tables: number;
}

/** Separate budgets per category (and per finance topic) so early sections cannot starve later ones. */
interface Budget {
  business: CategoryBudget;
  shares: CategoryBudget;
  finance: Record<FinanceTopic, CategoryBudget>;
}

const DEFAULT_BUDGET: Budget = {
  business: { sections: 10, tables: 25 },
  shares: { sections: 8, tables: 15 },
  finance: {
    investments: { sections: 4, tables: 8 },
    capex: { sections: 4, tables: 8 },
    debtMaturities: { sections: 4, tables: 8 },
    cashflow: { sections: 4, tables: 8 },
    committedFinancing: { sections: 4, tables: 8 },
    restrictedCash: { sections: 4, tables: 8 },
  },
};

export type PartialBudget = {
  business?: Partial<CategoryBudget>;
  shares?: Partial<CategoryBudget>;
  finance?: Partial<Record<FinanceTopic, Partial<CategoryBudget>>>;
};

function mergeBudget(custom: PartialBudget): Budget {
  return {
    business: { ...DEFAULT_BUDGET.business, ...custom.business },
    shares: { ...DEFAULT_BUDGET.shares, ...custom.shares },
    finance: Object.fromEntries(
      FINANCE_TOPICS.map((k) => [k, { ...DEFAULT_BUDGET.finance[k], ...custom.finance?.[k] }]),
    ) as Record<FinanceTopic, CategoryBudget>,
  };
}

export interface ExtractedTable {
  rows: string[][];
  text: string;
  unit: string | null;
  truncated: boolean;
}

export interface ExtractedSection {
  category: ExcerptCategory;
  financeTopic?: FinanceTopic;
  title: string;
  text: string;
  truncated: boolean;
  tables: ExtractedTable[];
}

type Item = string | { table: string };
interface Sec {
  title: string;
  items: Item[];
}

function parseTable(inner: string): string[][] {
  const rows: string[][] = [];
  for (const tr of inner.matchAll(/<TR\b[^>]*>([\s\S]*?)<\/TR>/gi)) {
    const cells = [...(tr[1] ?? "").matchAll(/<(TD|TH|TE|TU)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => plainText(m[2] ?? ""));
    if (cells.some((c) => c)) rows.push(cells);
  }
  return rows;
}

const renderRows = (rows: string[][]): string => rows.map((r) => r.join(" | ")).join("\n");

function unitNear(...texts: string[]): string | null {
  for (const t of texts) {
    const m = /단위\s*[:：]\s*([^)\]\n|]{1,30})/.exec(t);
    if (m?.[1]) return collapse(m[1]);
  }
  return null;
}

/**
 * Best-effort text/table extraction from DART pseudo-XML. All output is inert text: markup is stripped,
 * scripts dropped, entities decoded, control characters removed. Nested tables are not supported.
 */
export function extractDocument(xml: string, customBudget: PartialBudget = {}): ExtractedSection[] {
  const budget = mergeBudget(customBudget);
  const rawTables: string[] = [];
  let s = xml
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "") // frees \u0001/\u0002 for our markers
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<TABLE\b[^>]*>([\s\S]*?)<\/TABLE>/gi, (_m, inner: string) => `\n\u0001${rawTables.push(inner) - 1}\u0001\n`)
    .replace(/<TITLE\b[^>]*>([\s\S]*?)<\/TITLE>/gi, (_m, t: string) => `\n\u0002${plainText(t)}\n`)
    .replace(/<\/?(?:P|BR|DIV|SECTION-\d|LIBRARY|TR)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  s = decodeEntities(s);

  const secs: Sec[] = [{ title: "", items: [] }];
  for (const line of s.split("\n")) {
    const l = collapse(line);
    if (!l) continue;
    const cur = secs[secs.length - 1] as Sec;
    const tok = /^\u0001(\d+)\u0001$/.exec(l);
    if (l.startsWith("\u0002")) secs.push({ title: l.slice(1).trim(), items: [] });
    else if (tok) cur.items.push({ table: rawTables[Number(tok[1])] ?? "" });
    else cur.items.push(l);
  }

  const body = (sec: Sec): string =>
    sec.items.map((i) => (typeof i === "string" ? i : clip(renderRows(parseTable(i.table).slice(0, TABLE_ROWS)), TABLE_CHARS))).join("\n");

  const out: ExtractedSection[] = [];
  const sectionCount = new Map<string, number>();
  const tableCount = new Map<string, number>();
  const budgetOf = (category: ExcerptCategory, financeTopic: FinanceTopic | null): CategoryBudget =>
    category === "finance" ? budget.finance[financeTopic as FinanceTopic] : budget[category];
  const isChildBoundary = (title: string): boolean =>
    TOP_HEADING.test(title) || TARGET.test(title) || SHARES_TARGET.test(title) || FINANCE_TARGET.test(title);
  for (let i = 0; i < secs.length; i++) {
    const sec = secs[i] as Sec;
    if (!sec.title) continue;
    const financeTopic = financeTopicOf(sec.title);
    const category: ExcerptCategory | null = SHARES_TARGET.test(sec.title) ? "shares" : TARGET.test(sec.title) ? "business" : financeTopic ? "finance" : null;
    if (!category) continue;
    const key = category === "finance" ? `finance:${financeTopic}` : category;
    const catBudget = budgetOf(category, financeTopic);
    if ((sectionCount.get(key) ?? 0) >= catBudget.sections) continue;
    sectionCount.set(key, (sectionCount.get(key) ?? 0) + 1);
    let text = body(sec);
    // A bare parent heading: pull in following child sections (never crossing a top-level heading).
    for (let j = i + 1, extra = 0; text.length < 300 && j < secs.length && extra < 3; j++, extra++) {
      const next = secs[j] as Sec;
      if (isChildBoundary(next.title)) break; // matched children get their own excerpt
      text += `\n## ${next.title}\n${body(next)}`;
    }
    const tables: ExtractedTable[] = [];
    sec.items.forEach((it, idx) => {
      if (typeof it === "string" || (tableCount.get(key) ?? 0) >= catBudget.tables) return;
      const rows = parseTable(it.table);
      if (!rows.length) return;
      const shown = rows.slice(0, TABLE_ROWS);
      const full = renderRows(shown);
      const before = sec.items.slice(Math.max(0, idx - 2), idx).filter((x): x is string => typeof x === "string");
      tableCount.set(key, (tableCount.get(key) ?? 0) + 1);
      tables.push({
        rows: shown,
        text: clip(full, TABLE_CHARS),
        unit: unitNear(full, ...before.reverse()),
        truncated: rows.length > TABLE_ROWS || full.length > TABLE_CHARS,
      });
    });
    out.push({
      category,
      ...(financeTopic ? { financeTopic } : {}),
      title: clip(sec.title, 200),
      text: clip(text, SECTION_CHARS),
      truncated: text.length > SECTION_CHARS,
      tables,
    });
  }
  return out;
}

// ---- metric / product candidates (never verified, never converted) ----

const SHARE_KW = /점유율|점유|market\s*share/i;
const SIZE_KW = /시장\s*규모|시장규모|market\s*size|시장은|시장의\s*크기/i;
const GROWTH_KW = /성장률|cagr|성장/i;
const PCT = /(-?\d+(?:\.\d+)?)\s*%/g;
const MONEY = /(\d[\d,]*(?:\.\d+)?)\s*(조|억|천억|백만|천만|만|천)?\s*(원|달러|USD|US\$|\$|KRW|엔|위안|유로)/gi;
const PERIOD_HINT = /\d{4}\s*년(?:\s*\d\s*분기)?|Q[1-4]\s*\d{4}|\d{4}\s*Q[1-4]|\d\s*분기/;

function lastIndex(re: RegExp, s: string): number {
  let idx = -1;
  for (const m of s.matchAll(new RegExp(re.source, "gi"))) idx = m.index ?? idx;
  return idx;
}

function basisOf(s: string): MetricCandidate["basis"] {
  if (/분기|quarter|QoQ|Q[1-4]/i.test(s)) return /전년\s*동기|YoY/i.test(s) ? "yoy" : "quarterly";
  if (/전년\s*(동기)?\s*대비|YoY/i.test(s)) return "yoy";
  if (/연간|연평균|연도별|annual|yearly|per\s*year|CAGR/i.test(s)) return "annual";
  return "unspecified";
}

function measureOf(s: string): "revenue" | "volume" | "unspecified" {
  const rev = /매출|revenue|금액\s*기준/i.test(s);
  const vol = /출하|판매량|수량|물량|대수|units?\b|shipments?|볼륨/i.test(s);
  return rev === vol ? "unspecified" : rev ? "revenue" : "volume";
}

export function extractMetrics(text: string, source: SourceLocator, max = 60): MetricCandidate[] {
  const out: MetricCandidate[] = [];
  const sentences = text.split(/\n|(?<=[.!?。])\s+/).map(collapse).filter((x) => x.length > 5);
  for (const sent of sentences) {
    const context = clip(sent, 300);
    const base = { context, source, verificationStatus: "candidate" as const };
    const label = (idx: number) => clip(sent.slice(Math.max(0, idx - 40), idx).trim(), 60);
    const period = PERIOD_HINT.exec(sent)?.[0] ?? null;
    if (SHARE_KW.test(sent) || GROWTH_KW.test(sent)) {
      for (const m of [...sent.matchAll(PCT)].slice(0, 5)) {
        // attribute each percentage to the nearest preceding keyword (share vs growth)
        const win = sent.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
        const isShare = lastIndex(SHARE_KW, win) > lastIndex(GROWTH_KW, win);
        if (lastIndex(SHARE_KW, win) < 0 && lastIndex(GROWTH_KW, win) < 0) continue;
        out.push({
          ...base,
          kind: isShare ? "market_share" : "growth_rate",
          label: label(m.index ?? 0),
          rawText: m[0],
          value: Number(m[1]),
          unit: "%",
          scale: null,
          measure: isShare ? measureOf(sent) : null,
          basis: basisOf(sent),
          periodHint: period,
        });
      }
    }
    if (SIZE_KW.test(sent)) {
      for (const m of [...sent.matchAll(MONEY)].slice(0, 5)) {
        out.push({
          ...base,
          kind: "market_size",
          label: label(m.index ?? 0),
          rawText: m[0],
          value: Number((m[1] ?? "").replace(/,/g, "")),
          unit: m[3] ?? "",
          scale: m[2] ?? null,
          measure: null,
          basis: basisOf(sent),
          periodHint: period,
        });
      }
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

const NOT_PRODUCT = /^(합\s*계|총\s*계|소\s*계|계|기타|구분|합계|해당\s*없음|-)$/;

function validName(n: string): boolean {
  return n.length >= 2 && n.length <= 40 && /\p{L}/u.test(n) && !NOT_PRODUCT.test(n) && !/^[\d,.\s%()-]+$/.test(n);
}

export function extractProducts(
  sectionTitle: string,
  text: string,
  tables: ExtractedTable[],
  source: SourceLocator,
  max = 40,
): ProductCandidate[] {
  const out: ProductCandidate[] = [];
  const seen = new Set<string>();
  const add = (name: string, evidence: ProductCandidate["evidence"], context: string) => {
    const n = collapse(name);
    if (!validName(n) || seen.has(n.toLowerCase()) || out.length >= max) return;
    seen.add(n.toLowerCase());
    out.push({ name: n, evidence, context: clip(context, 200), source, verificationStatus: "candidate" });
  };
  if (PRODUCT_SECTION.test(sectionTitle)) {
    for (const t of tables) {
      const header = t.rows[0] ?? [];
      const found = header.findIndex((c) => /품목|제품|상품|서비스/.test(c));
      const col = found < 0 ? 0 : found;
      for (const row of t.rows.slice(1)) add(row[col] ?? "", "table_column", row.join(" | "));
    }
  }
  for (const m of text.matchAll(/(?:주요\s*(?:제품|상품|서비스)|제품)\s*(?:은|는|으로는|:)\s*([^.\n]{3,120})/g)) {
    for (const part of (m[1] ?? "").split(/,|·|\/|\s및\s|\s와\s|\s과\s/)) add(part.replace(/\s*등(?:\s|입니다|이다|이며|을|의|$).*$/, ""), "text_list", m[0]);
  }
  return out;
}
