// Common-stock (보통주) eligibility. The server analyses operating companies only: preferred shares (우선주),
// ETF/ETN, REITs and other pass-through vehicles (infrastructure/ship funds, SPACs) are rejected.
// Pure functions; the callers supply whatever Naver/DART fields they have. Names are matched on Korean/English
// legal-name conventions, so this is a best-effort screen, not an exchange-issued classification.

export type SecurityRejection = { code: "PREFERRED_STOCK" | "ETF_ETN" | "REIT" | "INFRA_FUND" | "SPAC" | "SHIP_FUND" | "NON_STOCK"; message: string };

export type SecurityFacts = {
  ticker: string;
  /** Display/legal names from any source (Naver stockName, DART corp_name, dataset company.name). */
  names?: (string | null | undefined)[];
  /** Naver `stockEndType`: "stock" for equities, "etf"/"etn"/... otherwise. */
  endType?: string | null;
  /** DART `induty_code` (KSIC). */
  industryCode?: string | null;
  /** Apply the ticker-suffix rule. Off for user-supplied datasets whose tickers may be fictional. */
  checkTickerSuffix?: boolean;
};

// Korean preferred shares keep the common code's first five digits and end in 5/7/9 (or a letter for newer series);
// a six-digit numeric common-stock code ends in 0.
const PREFERRED_NAME = /(?:\d우[ABC]?|우[ABC]|우\(전환\)|우선주)$|\(우\)/;
const ETF_NAME = /\b(?:ETF|ETN)\b|^(?:KODEX|TIGER|KBSTAR|ARIRANG|HANARO|KOSEF)\b|상장지수/;
// English tokens are matched as whole words only: DART's English legal names are screened too, and a bare
// substring match rejected operating companies ("Hanwha AeroSPACe" looked like a SPAC).
const REIT_NAME = /리츠|\bREITs?\b|부동산투자회사|부동산투자신탁|위탁관리|기업구조조정부동산/i;
// Listed infrastructure funds by legal-name wording; the short name "맥쿼리인프라" is listed explicitly instead of any
// name ending in "인프라", which would also reject operating companies. DART's KSIC 6420x catches the rest.
const INFRA_NAME = /인프라(?:투융자|펀드)|투융자회사|사회기반시설|^맥쿼리인프라$/;
const SPAC_NAME = /스팩|기업인수목적|\bSPAC\b|\bSpecial Purpose Acquisition\b/i;
const SHIP_NAME = /선박투자회사/;
// KSIC 6420x: trusts & collective investment vehicles (e.g. Macquarie Korea Infrastructure Fund).
const FUND_INDUSTRY = /^6420\d?$/;

export function classifySecurity(f: SecurityFacts): SecurityRejection[] {
  const out: SecurityRejection[] = [];
  const names = (f.names ?? []).map((n) => (n ?? "").trim()).filter(Boolean);
  // The matching name is quoted in the message so a false positive can be traced to the exact source string.
  const named = (re: RegExp) => names.find((n) => re.test(n));
  const by = (n: string) => ` (matched name "${n.slice(0, 80)}")`;
  let hit: string | undefined;

  if (f.endType && f.endType.toLowerCase() !== "stock")
    out.push({ code: /^et[fn]$/i.test(f.endType) ? "ETF_ETN" : "NON_STOCK", message: `Instrument type "${f.endType}" is not a common stock` });
  else if ((hit = named(ETF_NAME))) out.push({ code: "ETF_ETN", message: `Name indicates an ETF/ETN${by(hit)}` });

  if ((f.checkTickerSuffix ?? true) && /^\d{6}$/.test(f.ticker) && !f.ticker.endsWith("0"))
    out.push({ code: "PREFERRED_STOCK", message: `Ticker ${f.ticker} does not end in 0, which marks a preferred (or other non-common) share class` });
  else if ((hit = named(PREFERRED_NAME))) out.push({ code: "PREFERRED_STOCK", message: `Name indicates a preferred share (우선주)${by(hit)}` });

  if ((hit = named(REIT_NAME))) out.push({ code: "REIT", message: `Name indicates a REIT (부동산투자회사/리츠)${by(hit)}` });
  if ((hit = named(INFRA_NAME))) out.push({ code: "INFRA_FUND", message: `Listed infrastructure/investment fund, not an operating company${by(hit)}` });
  else if (f.industryCode && FUND_INDUSTRY.test(f.industryCode)) out.push({ code: "INFRA_FUND", message: `Listed infrastructure/investment fund, not an operating company (KSIC ${f.industryCode})` });
  if ((hit = named(SPAC_NAME))) out.push({ code: "SPAC", message: `Name indicates a special purpose acquisition company (스팩)${by(hit)}` });
  if ((hit = named(SHIP_NAME))) out.push({ code: "SHIP_FUND", message: `Name indicates a ship investment company (선박투자회사)${by(hit)}` });
  return out;
}

export const isCommonStock = (f: SecurityFacts): boolean => classifySecurity(f).length === 0;

/** One-line, user-facing reason list. */
export const describeRejections = (r: SecurityRejection[]): string => r.map((x) => x.message).join("; ");

// ---- listing ---------------------------------------------------------------------------------------------------
// Analysis covers KOSPI and KOSDAQ listings; classifySecurity above still limits it to common shares.

/** Six-character KRX code: numeric (005930) or the newer alphanumeric series (0126Z0). */
export const KRX_TICKER = /^[0-9][0-9A-Z]{5}$/;

export type ListedExchange = "KOSPI" | "KOSDAQ";

/** Naver `stockExchangeType.code` ("KS"/"KQ") or DART `corp_cls` ("Y"/"K") -> exchange; anything else is null. */
export const exchangeOf = (code: string): ListedExchange | null =>
  code === "KS" || code === "Y" ? "KOSPI" : code === "KQ" || code === "K" ? "KOSDAQ" : null;
