// Public evidence collection types. Everything here is *untrusted evidence*, never instructions.

export type ProviderName = "naver" | "naver-search" | "dart" | "sec" | "edinet" | "fx";
export type ProviderStatus = "ok" | "partial" | "failed" | "not_configured";

export interface CollectionIssue {
  provider: ProviderName | "collector";
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface ProviderReport {
  status: ProviderStatus;
  issues: CollectionIssue[];
}

export interface CollectPublicEvidenceInput {
  ticker: string;
  /** YYYY-MM-DD (inclusive through end of that day, KST) or an ISO timestamp with timezone. */
  asOf: string;
  /** Optional competitors to compare, KR/US/JP only: "KR:000660" (DART), "US:MU" (SEC EDGAR), "JP:8035" (EDINET). Max 6. */
  competitors?: string[];
}

export interface CollectionOptions {
  fetch?: typeof fetch;
  /** Defaults to process.env. Read: DART_API_KEY, NAVER_CLIENT_ID, NAVER_CLIENT_SECRET, SEC_USER_AGENT, EDINET_API_KEY. */
  env?: Record<string, string | undefined>;
  now?: () => Date;
  signal?: AbortSignal;
  timeoutMs?: number; // per request, default 15000
  maxResponseBytes?: number; // per response, default 20 MiB
  maxDecompressedBytes?: number; // per ZIP total, default 64 MiB
  maxRequests?: number; // per collection call, default 48
  maxNewsPages?: number; // default 3, hard cap 3
  maxArticles?: number; // Naver article bodies fetched (n.news.naver.com only), default 5, clamped 0..5
  maxFilings?: number; // default 8, clamped 1..8
  maxDocuments?: number; // filing documents downloaded, default 4, clamped 0..8
  cacheTtlMs?: number; // naver / DART JSON, default 60s
  corpCodeTtlMs?: number; // default 24h
  documentTtlMs?: number; // default 1h
  competitorTtlMs?: number; // competitor filings/facts, default 6h
  /** Persistent cache directory for filing content (DART/SEC/EDINET). Unset = memory cache only. */
  cacheDir?: string;
  /** Replaces the default Naver Open API search queries (outlook/growth/share + product markets; max 6). */
  productQueries?: string[];
}

export interface QuoteEvidence {
  ticker: string;
  name: string;
  exchange: { code: string; name: string; nameEng: string };
  close: number;
  currency: "KRW";
  /** Time of the last trade reported by Naver (ISO with offset). */
  tradedAt: string;
  retrievedAt: string;
  /** Latest-snapshot quote, not a historical close query. Never later than asOf (else rejected). */
  kind: "latest_snapshot";
  tradedOnAsOfDate: boolean;
  sourceUrl: string;
}

export interface ReferenceMetric {
  code: string;
  label: string;
  rawValue: string;
  rawDescription: string | null;
  value: number | null;
  unit: string | null;
  role: "trailing_reference" | "consensus_reference" | "market_value_reference" | "other_reference";
  /** Always false: reference figures are not product-market or share-count model inputs. */
  usableAsModelInput: false;
  retrievedAt: string;
  sourceUrl: string;
}

/** One provider-marked quarterly estimate, independent of the stricter four-quarter diluted-EPS strategy. */
export interface QuarterlyConsensus {
  ticker: string;
  quarter: string;
  revenueKRW: number | null;
  operatingProfitKRW: number | null;
  netIncomeKRW: number | null;
  epsKRW: number | null;
  scope: "provider_default";
  epsBasis: "unspecified";
  /** Observation time, NOT the publication/update time of the underlying analyst reports. */
  observedAt: string;
  sourceUrl: string;
}

/** One reported (non-consensus) quarter from the same Naver quarterly finance table. EPS in KRW per share. */
export interface QuarterlyActual {
  ticker: string;
  quarter: string;
  epsKRW: number;
  scope: "provider_default";
  epsBasis: "unspecified";
  observedAt: string;
  sourceUrl: string;
}

/** One daily close (KRX session date, KST) from Naver's daily price list. */
export interface DailyClose {
  date: string;
  closeKRW: number;
}

/** One fiscal year from Naver's annual finance table (KRW); `isConsensus` marks provider consensus columns. */
export interface AnnualFinance {
  ticker: string;
  /** Fiscal-year label as printed, e.g. "2026.12". */
  period: string;
  isConsensus: boolean;
  revenueKRW: number | null;
  operatingProfitKRW: number | null;
  netIncomeKRW: number | null;
  epsKRW: number | null;
  observedAt: string;
  sourceUrl: string;
}

/** Trailing PER reference computed from collected daily closes and the latest four reported quarterly EPS values. */
export interface PerReference {
  /** Sum of the latest four consecutive reported quarters' EPS (KRW per share, provider basis unspecified). */
  ttmEpsKRW: number;
  quarters: string[];
  latestClose: { date: string; closeKRW: number };
  /** latestClose / ttmEps. */
  current: number;
  /** Closes over the collected window divided by the SAME current TTM EPS (a price range, not a historical PER series). */
  window: { from: string; to: string; sessions: number; min: number; median: number; max: number };
  sourceUrls: string[];
}

/** KRW per one unit of a currency, from a dated reference rate published before asOf. */
export interface FxRate {
  currency: string;
  krwPerUnit: number;
  /** Reference-rate date (YYYY-MM-DD). */
  rateDate: string;
  source: string;
  sourceUrl: string;
}

export interface NewsItem {
  id: string;
  title: string;
  snippet: string;
  /** ISO with +09:00 offset. */
  publishedAt: string;
  officeName: string | null;
  url: string;
  originalUrl: string | null;
  origin: "naver-stock-news" | "naver-search";
  /** Optional: cleaned body of the article (Naver `dic_area`), max 8000 chars. Absent when not fetched or on failure. */
  articleText?: string;
  articleTruncated?: boolean;
  /** Publication time read from the article page (ISO with offset), when available and consistent with the listing. */
  articlePublishedAt?: string;
}

export type FilingPeriodType = "Q1" | "H1" | "Q3" | "FY";

export interface FilingEvidence {
  rceptNo: string;
  receiptUrl: string;
  reportName: string;
  receivedDate: string; // YYYY-MM-DD
  period: { type: FilingPeriodType; end: string; fiscalYear: number };
  isCorrection: boolean;
}

/**
 * Exchange (거래소) disclosures that matter for the earnings-gap strategy: a scheduled earnings release/IR event
 * (catalyst), the company's own earnings guidance, and preliminary (잠정) results. Collected from DART
 * pblntf_ty "I"; received on or before asOf only. Company statements, NOT analyst consensus.
 */
export type DisclosureKind = "earnings_schedule" | "earnings_guidance" | "preliminary_earnings";

export interface ExchangeDisclosure {
  rceptNo: string;
  receiptUrl: string;
  reportName: string;
  receivedDate: string; // YYYY-MM-DD
  kind: DisclosureKind;
  isCorrection: boolean;
  /** Plain text of the disclosure document; each table is flattened onto ONE line ("cell | cell / next row"). */
  text: string;
  truncated: boolean;
}

export interface SourceLocator {
  rceptNo: string;
  receiptUrl: string;
  reportName: string;
  periodEnd: string;
  sectionTitle: string;
}

/**
 * business: product/market sections; shares: share counts, EPS, capital, preferred, non-controlling interest;
 * finance: investing/financing-side notes (investments, CAPEX, debt maturities, cashflow, committed financing,
 * restricted cash) that strategy/auto.ts funding-risk logic reads from.
 */
export type ExcerptCategory = "business" | "shares" | "finance";

/** Sub-areas within the "finance" category, each with its own extraction budget so none starves another. */
export type FinanceTopic = "investments" | "capex" | "debtMaturities" | "cashflow" | "committedFinancing" | "restrictedCash";

export interface TextExcerpt extends SourceLocator {
  category?: ExcerptCategory;
  /** Present only when category is "finance". */
  financeTopic?: FinanceTopic;
  text: string;
  truncated: boolean;
}

export interface TableEvidence extends SourceLocator {
  category?: ExcerptCategory;
  /** Present only when category is "finance". */
  financeTopic?: FinanceTopic;
  /** Unit as printed near the table (e.g. "백만원"); null if not found. Never converted. */
  unit: string | null;
  rows: string[][];
  text: string;
  truncated: boolean;
}

export type MetricKind = "market_share" | "market_size" | "growth_rate";

export interface MetricCandidate {
  kind: MetricKind;
  label: string;
  rawText: string;
  value: number;
  /** "%" or the printed currency word; scale (조/억/백만 ...) kept separately, not applied. */
  unit: string;
  scale: string | null;
  /** market_share: what the share is measured on. Volume shares are never treated as revenue shares. */
  measure: "revenue" | "volume" | "unspecified" | null;
  /** How the source period was stated; annual and quarterly are never converted. */
  basis: "annual" | "quarterly" | "yoy" | "unspecified";
  periodHint: string | null;
  context: string;
  source: SourceLocator;
  verificationStatus: "candidate";
}

export interface ProductCandidate {
  name: string;
  evidence: "table_column" | "text_list";
  context: string;
  source: SourceLocator;
  verificationStatus: "candidate";
}

export interface StatementRow {
  statement: "BS" | "IS" | "CIS" | "CF";
  accountId: string;
  accountName: string;
  currency: string | null;
  /** DART "thstrm_*": for IS/CIS in Q1/H1/Q3 reports thisTermAmount is the 3-month figure. */
  thisTermLabel: string | null;
  thisTermAmount: number | null;
  /** DART "thstrm_add_amount": cumulative year-to-date (6M in H1, 9M in Q3). */
  thisTermCumulativeAmount: number | null;
  priorTermLabel: string | null;
  priorTermAmount: number | null;
  priorQuarterLabel: string | null;
  priorQuarterAmount: number | null;
  priorCumulativeAmount: number | null;
}

export interface StatementSet {
  fiscalYear: number;
  period: FilingPeriodType;
  periodEnd: string;
  reportCode: "11011" | "11012" | "11013" | "11014";
  fsDiv: "CFS" | "OFS";
  rceptNo: string;
  receiptUrl: string;
  /** thisTermAmount covers 3 months for Q1/H1/Q3 and the full year for FY. */
  thisTermCovers: "3_months" | "12_months";
  cumulativeCovers: "none" | "6_months" | "9_months";
  amountsInCurrencyUnits: true;
  rows: StatementRow[];
  rowsTruncated: boolean;
}

export interface DerivedQuarter {
  fiscalYear: number;
  quarter: 4;
  periodEnd: string;
  fsDiv: "CFS" | "OFS";
  method: "annual_minus_q3_cumulative";
  annualRceptNo: string;
  q3RceptNo: string;
  verificationStatus: "derived";
  rows: {
    statement: "IS" | "CIS";
    accountId: string;
    accountName: string;
    currency: string | null;
    amount: number;
    annualAmount: number;
    q3CumulativeAmount: number;
  }[];
}

export type CompetitorMarket = "KR" | "US" | "JP";

/** One reported (or derived) revenue period of a competitor, exactly as filed: no FX, no scaling, no calendarisation. */
export interface CompetitorPeriod {
  /** 3 = quarter, 6 = half-year, 12 = fiscal year. */
  months: 3 | 6 | 12;
  periodStart: string | null;
  periodEnd: string;
  /** Filer's own label, e.g. "FY2026 Q3", "2026 반기", "2025年度 中間". */
  fiscalLabel: string;
  /** Calendar quarter holding most of a quarter ("2026Q2"), or the calendar quarters a half/year covers ("2025Q2~2025Q3"). */
  calendarPeriod: string;
  /** "exact" when periodEnd is within 7 days of that calendar period's end. */
  calendarAlignment: "exact" | "approximate";
  currency: string;
  revenue: number;
  /** "derived": FY minus the other periods of the same fiscal year (Q4 or H2); never a direct filing value. */
  basis: "reported" | "derived";
  consolidated: boolean | null;
  /** Filing (receipt/submission) date, KST calendar date on or before asOf. */
  filedDate: string;
  form: string;
  sourceUrl: string;
  /** The revenue element/account used (e.g. us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax, 매출액). */
  concept: string;
}

/** One share class from DART "주식의 총수 현황" (stockTotqySttus) for a periodic filing. Counts are shares. */
export interface ShareClassCount {
  kind: "common" | "preferred" | "total" | "other";
  label: string;
  issued: number | null;
  treasury: number | null;
  outstanding: number | null;
}

export interface ShareCountEvidence {
  fiscalYear: number;
  period: FilingPeriodType;
  periodEnd: string;
  rceptNo: string;
  receiptUrl: string;
  receivedDate: string;
  classes: ShareClassCount[];
}

export interface CompetitorEvidence {
  market: CompetitorMarket;
  /** Local code: KRX ticker, US ticker or TSE securities code. */
  code: string;
  name: string | null;
  system: "DART" | "SEC EDGAR" | "EDINET";
  /** Newest first. */
  periods: CompetitorPeriod[];
}

export type RequiredInputStatus =
  | "missing"
  | "candidate_only"
  | "reference_only"
  | "available_unverified";

export interface RequiredInput {
  field: string;
  status: RequiredInputStatus;
  detail: string;
}

export interface PublicEvidence {
  schemaVersion: "collection-evidence/1";
  ticker: string;
  asOf: { input: string; cutoff: string; dateKst: string };
  collectedAt: string;
  /** Upstream network requests made by this call (cache hits are free). */
  requestsUsed: number;
  status: "ok" | "partial" | "failed";
  /** The collector never asserts that a valuation model can run from this evidence alone. */
  modelReady: false;
  untrustedContentNotice: string;
  /** `competitors` is present only when competitors were requested (one report per requested market). */
  providers: { naver: ProviderReport; naverSearch: ProviderReport; dart: ProviderReport; fx?: ProviderReport; competitors?: Partial<Record<CompetitorMarket, ProviderReport>> };
  issues: CollectionIssue[];
  company: {
    name: string | null;
    corpCode: string | null;
    exchange: "KOSPI" | null;
    exchangeVerifiedBy: ("naver" | "dart")[];
  };
  market: {
    quote: QuoteEvidence | null;
    referenceMetrics: ReferenceMetric[];
    quarterlyConsensus?: QuarterlyConsensus[];
    /** Reported quarterly EPS (live snapshot only; absent for a historical asOf). */
    quarterlyActuals?: QuarterlyActual[];
    /** Daily closes on or before asOf, newest first (live runs only; about 8 months). */
    dailyCloses?: DailyClose[];
    /** Naver annual actuals and consensus (live snapshot only). */
    annualFinance?: AnnualFinance[];
    /** Trailing PER reference derived from dailyCloses and quarterlyActuals (live runs only). */
    perReference?: PerReference | null;
    /** KRW reference rates for common market currencies, dated before asOf. */
    fxRates?: FxRate[];
    news: NewsItem[];
    searchNews: NewsItem[];
  };
  filings: {
    list: FilingEvidence[];
    statements: StatementSet[];
    derivedQuarters: DerivedQuarter[];
    excerpts: TextExcerpt[];
    tables: TableEvidence[];
    metricCandidates: MetricCandidate[];
    productCandidates: ProductCandidate[];
    /** Exchange disclosures (IR/earnings schedule, guidance, preliminary results). Absent in older snapshots. */
    disclosures?: ExchangeDisclosure[];
    /** DART share totals (issued / treasury / outstanding by class) for the latest periodic filing. */
    shareCounts?: ShareCountEvidence[];
  };
  /** Competitors' filed revenue (KR/US/JP disclosure systems). Absent when none were requested. */
  competitors?: CompetitorEvidence[];
  requiredInputs: RequiredInput[];
}

export class CollectionError extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "CollectionError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class CollectionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectionInputError";
  }
}

export function issue(
  provider: CollectionIssue["provider"],
  code: string,
  message: string,
  severity: CollectionIssue["severity"] = "error",
): CollectionIssue {
  return { provider, code, severity, message };
}
