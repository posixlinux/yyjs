import type { StatementRow, StatementSet } from "../collection/types.js";
import { SingleQuarterFundingPlanSchema, type FundingPlan } from "./schema.js";

// Deterministic, source-linked funding plan for the automatic single-quarter path, derived from the SAME DART
// consolidated statements that were sent to the models. Used only when the model-authored plan is missing or failed
// verification, so funding risk no longer depends entirely on one LLM reply that the strict schema may reject.
//
// Rules (every one is stated in the plan's rationale, never hidden):
// - Consolidated (CFS) only; never mixed with separate (OFS) statements.
// - Opening balances = the balance sheet at the END of the quarter immediately preceding the forecast quarter, so
//   they are exactly the balances at the start of the horizon. Any other date would need an unmodelled stub period:
//   the plan is then unavailable with that reason, never carried forward silently.
// - DART cash-flow amounts are year-to-date (Q1=3, H1=6, Q3=9, FY=12 months); quarterly flows are the YTD amount
//   divided by the number of quarters it covers (a run-rate assumption, not a disclosed plan).
// - Operating cash is reconciled to the reported "cash generated from operations": the residual after operating
//   profit, D&A and core working capital goes to otherOperatingCashFlowKRW, so nothing is dropped or double counted.
// - Rows the statement does not contain are named in the rationale; required inputs that are absent make the plan
//   unavailable instead of being replaced by 0.
// - Debt rows are classified as current (due within 12 months) or non-current; a suspected total/sub-total row next
//   to detail rows, an unclassifiable row or a repeated account makes the plan unavailable (no double counting).
// - Restricted cash is deducted only when a row states it is part of cash and cash equivalents; any other restricted-
//   cash disclosure in the collected evidence makes the plan unavailable. When nothing is found, the plan says so as
//   an explicit assumption (not a verified fact).
// - No refinancing: current debt is repaid, spread evenly over the next four quarters (maturity timing within the
//   12 months is not disclosed in the statements and is labelled as an assumption); the all-due-now bound is exposed.

export type FundingDerivation =
  | {
      status: "derived"; plan: FundingPlan; statement: { rceptNo: string; period: string; periodEnd: string; url: string }; limitations: string[];
      /** Current (<=12 months) interest-bearing debt at the horizon start and the part assumed due in the quarter. */
      noRefinancing: { currentDebtKRW: number; assumedPrincipalDueKRW: number };
      restrictedCash: { status: "deducted" | "not_found_in_collected_evidence"; deductedKRW: number };
    }
  | { status: "unavailable"; code: string; message: string };

type DocRef = { url: string; publishedAt: string };
/** Filing excerpts/tables (collection ExcerptEvidence/TableEvidence) scanned for restricted-cash disclosures. */
type NoteRef = { rceptNo: string; sectionTitle: string; text: string };

const RESTRICTED = /사용\s*(이\s*)?제한|제한\s*된?\s*(예금|현금|금융)|담보\s*제공.{0,10}(예금|현금)|RestrictedCash|RestrictedDeposit/i;
const CASH_EQUIV = /현금\s*및\s*현금성\s*자산|CashAndCashEquivalents/i;

const MONTHS: Record<StatementSet["period"], number> = { Q1: 3, H1: 6, Q3: 9, FY: 12 };

const prevQuarterEnd = (quarter: string): string | null => {
  const m = /^(\d{4})Q([1-4])$/.exec(quarter);
  if (!m) return null;
  const y = Number(m[1]);
  const q = Number(m[2]);
  return q === 1 ? `${y - 1}-12-31` : `${y}-${["03-31", "06-30", "09-30"][q - 2]}`;
};

const krw = (r: StatementRow) => r.currency === "KRW";
const label = (r: StatementRow) => `${r.accountName} ${r.accountId}`;
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Year-to-date amount of a flow row: IS/CIS interim reports carry the 3-month figure in thisTerm and YTD in the
 * cumulative column; CF rows are already YTD in thisTerm. */
const ytd = (s: StatementSet, r: StatementRow): number | null =>
  r.statement === "CF" || s.period === "Q1" || s.period === "FY" ? r.thisTermAmount : r.thisTermCumulativeAmount;

export function deriveFundingPlan(statements: StatementSet[], documents: DocRef[], quarter: string, notes: NoteRef[] = []): FundingDerivation {
  const unavailable = (code: string, message: string): FundingDerivation => ({ status: "unavailable", code, message });
  const openingDate = prevQuarterEnd(quarter);
  if (!openingDate) return unavailable("FUNDING_DERIVATION_UNAVAILABLE", `전망 분기 ${quarter} 형식을 해석할 수 없습니다.`);
  const s = statements.find((x) => x.fsDiv === "CFS" && x.periodEnd === openingDate);
  if (!s) {
    const have = statements.map((x) => `${x.periodEnd}(${x.fsDiv === "CFS" ? "연결" : "별도"})`).join(", ") || "없음";
    return unavailable("FUNDING_OPENING_BALANCE_UNAVAILABLE",
      `공시 기반 자금 계획 파생 불가: 전망 분기 ${quarter} 시작 직전(${openingDate}) 연결 재무제표가 수집되지 않았습니다(수집된 기말: ${have}). 보고일 이후 미공시 기간의 현금흐름은 추정하지 않습니다.`);
  }
  const doc = documents.find((d) => d.url === s.receiptUrl);
  if (!doc) return unavailable("FUNDING_SOURCE_NOT_SUPPLIED", `공시 기반 자금 계획 파생 불가: ${openingDate} 연결 재무제표(접수번호 ${s.rceptNo})가 분석 문서에 포함되지 않아 출처를 연결할 수 없습니다.`);

  const n = MONTHS[s.period] / 3;
  const rows = s.rows.filter(krw);
  const find = (stmt: StatementRow["statement"][], re: RegExp, not?: RegExp) =>
    rows.filter((r) => stmt.includes(r.statement) && re.test(label(r)) && !(not && not.test(label(r))));
  const one = (stmt: StatementRow["statement"][], re: RegExp, not?: RegExp) => find(stmt, re, not)[0];
  const sumYtd = (list: StatementRow[]) => list.reduce((acc, r) => acc + Math.abs(ytd(s, r) ?? 0), 0);
  const names = (list: StatementRow[]) => list.map((r) => r.accountName).join("+");

  // ---- required inputs --------------------------------------------------------------------------------------
  const cashRow = one(["BS"], /(^현금및현금성자산\s)|ifrs-full_CashAndCashEquivalents$/);
  const opRow = one(["IS", "CIS"], /^영업이익|OperatingIncomeLoss/);
  const cgoRow = one(["CF"], /영업(으로부터|에서)\s*창출된\s*현금|CashFlowsFromUsedInOperations$|NetCashflowsFromUsedInOperations/);
  const capexRows = find(["CF"], /^(유형자산|무형자산)의?\s*취득|PurchaseOfPropertyPlantAndEquipment|PurchaseOfIntangibleAssets/, /처분|Proceeds/);
  const missing: string[] = [];
  if (!cashRow || cashRow.thisTermAmount === null) missing.push("재무상태표 현금및현금성자산");
  if (!opRow || ytd(s, opRow) === null) missing.push("손익계산서 영업이익(누적)");
  if (!cgoRow || cgoRow.thisTermAmount === null) missing.push("현금흐름표 영업에서 창출된 현금");
  if (!capexRows.length) missing.push("현금흐름표 유형·무형자산 취득");
  if (missing.length)
    return unavailable("FUNDING_STATEMENT_ROWS_MISSING", `공시 기반 자금 계획 파생 불가: ${s.fiscalYear} ${s.period} 연결 재무제표에 필수 행이 없습니다: ${missing.join(", ")}.`);

  // ---- balances ---------------------------------------------------------------------------------------------
  const debt = classifyDebt(find(["BS"], /차입금|사채|유동성장기부채|Borrowings|BondsIssued/, /리스|Lease|이자|미지급|충당|대여|자산|Assets|Receivable|전환권|Derivative/));
  if ("error" in debt) return unavailable("FUNDING_DEBT_ROWS_AMBIGUOUS", `공시 기반 자금 계획 파생 불가: ${s.fiscalYear} ${s.period} 연결 재무상태표 차입금 행을 중복 없이 분류할 수 없습니다: ${debt.error}`);
  const debtRows = [...debt.current, ...debt.noncurrent];
  const currentDebt = debt.current.reduce((acc, r) => acc + r.thisTermAmount!, 0);
  const openingDebt = currentDebt + debt.noncurrent.reduce((acc, r) => acc + r.thisTermAmount!, 0);

  // Restricted cash: deducted only when explicitly stated as part of cash and cash equivalents.
  const restrictedRows = s.rows.filter((r) => r.statement === "BS" && RESTRICTED.test(label(r)));
  const inCash = restrictedRows.filter((r) => CASH_EQUIV.test(label(r)));
  const restrictedNotes = notes.filter((x) => x.rceptNo === s.rceptNo && RESTRICTED.test(`${x.sectionTitle} ${x.text}`));
  const unresolved = [...restrictedRows.filter((r) => !inCash.includes(r)).map((r) => `재무상태표 '${r.accountName}'`),
    ...(inCash.length ? [] : restrictedNotes.map((x) => `주석 '${x.sectionTitle}'`))];
  if (inCash.some((r) => !krw(r) || r.thisTermAmount === null) || unresolved.length)
    return unavailable("FUNDING_RESTRICTED_CASH_UNRESOLVED",
      `공시 기반 자금 계획 파생 불가: 사용제한 현금·예금 공시(${unresolved.join(", ") || inCash.map((r) => r.accountName).join(", ")})가 있으나 현금및현금성자산에 포함된 제한 금액을 구조적으로 확인할 수 없어 비제한 기초 현금을 확정하지 않습니다.`);
  const restrictedKRW = inCash.reduce((acc, r) => acc + Math.abs(r.thisTermAmount!), 0);
  const openingCash = cashRow!.thisTermAmount! - restrictedKRW;
  if (openingCash < 0) return unavailable("FUNDING_RESTRICTED_CASH_UNRESOLVED", `공시 기반 자금 계획 파생 불가: 사용제한 금액 ${fmt(restrictedKRW)}원이 현금및현금성자산보다 커서 범위가 불일치합니다.`);

  // ---- flows (YTD -> quarterly run-rate) --------------------------------------------------------------------
  const opYtd = ytd(s, opRow!)!;
  const cgoYtd = cgoRow!.thisTermAmount!;
  const daRows = find(["CF"], /감가상각비|무형자산상각비|사용권자산상각비|Depreciation|Amortisation|Amortization/, /처분|손상/);
  const daYtd = sumYtd(daRows);
  const capexYtd = sumYtd(capexRows);
  const taxRows = find(["CF"], /법인세.*(납부|지급)|IncomeTaxesPaid/, /환급|Refund(?!Classified)/);
  const interestRows = find(["CF"], /이자.*지급|InterestPaid/, /신종자본|Hybrid/);
  const payoutRows = find(["CF"], /배당금.*지급|DividendsPaid|자기주식.*취득|PurchaseOfTreasuryShares|신종자본.*이자|InterestPaidToHybrid/);

  // Core working capital from the balance sheet (period end vs. prior fiscal year end, the start of the YTD window).
  const wcParts: [RegExp, number][] = [[/^매출채권|TradeAndOtherCurrentReceivables$|CurrentTradeReceivables$/, 1], [/^재고자산|ifrs-full_Inventories$/, 1], [/^매입채무|TradeAndOtherCurrentPayables$|CurrentTradePayables$/, -1]];
  let wcYtd: number | null = 0;
  const wcUsed: string[] = [];
  for (const [re, sign] of wcParts) {
    const r = one(["BS"], re, /장기|NonCurrent|Noncurrent/);
    if (!r || r.thisTermAmount === null || r.priorTermAmount === null) { wcYtd = null; break; }
    wcYtd += sign * (r.thisTermAmount - r.priorTermAmount);
    wcUsed.push(r.accountName);
  }

  const q = (ytdAmount: number) => ytdAmount / n;
  const dWc = wcYtd === null ? 0 : q(wcYtd);
  const da = q(daYtd);
  const other = q(cgoYtd - opYtd - daYtd + (wcYtd ?? 0));
  // No refinancing and no uncommitted new borrowing: every current (<=12 months) borrowing is repaid. The statements
  // do not say WHEN within the 12 months, so an even spread over four quarters is assumed; the all-due-now bound is
  // returned separately (noRefinancing) so the caller can show it instead of hiding the concentration risk.
  const principal = currentDebt / 4;
  const restrictedText = restrictedKRW > 0
    ? `사용제한 현금(${inCash.map((r) => r.accountName).join("+")}) ${fmt(restrictedKRW)}원을 현금및현금성자산에서 차감했습니다.`
    : "수집된 재무제표·주석 발췌에서 사용제한 현금 표시를 찾지 못해 현금및현금성자산 전액을 비제한으로 가정했습니다(제한 금액 0이 확인된 것은 아니며 주석 전체를 수집하지 못했을 수 있음).";
  const limitations: string[] = [
    restrictedText,
    `차환·신규 차입 없음: 1년 내 만기 차입(${debt.current.map((r) => r.accountName).join("+") || "없음"}) ${fmt(currentDebt)}원을 전액 상환하되, 만기 시점이 공시되지 않아 향후 4개 분기에 균등 도래(분기 ${fmt(principal)}원)한다고 가정했습니다. 이번 분기에 전액 도래하면 상환액은 ${fmt(currentDebt)}원입니다.`,
    `CF 누적(${MONTHS[s.period]}개월) 금액을 ${n}개 분기로 나눈 분기 평균을 ${quarter}에도 유지한다고 가정했습니다(계절성·일회성 미반영, 공시된 투자 계획 아님).`,
    "리스부채와 그 상환은 차입금·상환액에 포함하지 않았습니다.",
  ];
  if (!daRows.length) limitations.push("현금흐름표에 감가상각비 행이 없어 D&A를 별도 표시하지 않고 기타 영업현금 조정(영업창출현금 잔차)에 포함했습니다.");
  if (wcYtd === null) limitations.push("매출채권·재고자산·매입채무 중 비교 가능한 행이 없어 운전자본 증감을 별도 표시하지 않고 기타 영업현금 조정에 포함했습니다.");
  if (!taxRows.length) limitations.push("현금흐름표에 법인세 납부 행이 없어 누적 기간 현금 법인세를 0으로 관측했습니다.");
  if (!interestRows.length) limitations.push("현금흐름표에 이자 지급 행이 없어 누적 기간 현금 이자를 0으로 관측했습니다.");

  const source = { title: `DART 연결 재무제표 ${s.fiscalYear} ${s.period} (기말 ${s.periodEnd}, 접수번호 ${s.rceptNo})`, url: s.receiptUrl, kind: "filing" as const, knownAt: `${doc.publishedAt}T00:00:00+09:00` };
  const planRationale = clip(
    `[공시 재무제표 결정론적 파생, 모델 추정 아님] 기초 비제한 현금=${s.periodEnd} 연결 BS 현금및현금성자산 ${fmt(cashRow!.thisTermAmount!)}원-사용제한 ${fmt(restrictedKRW)}원=${fmt(openingCash)}원, 기초 차입=${debtRows.length ? `${names(debtRows)} 합계` : "차입금·사채 행 없음(0)"} ${fmt(openingDebt)}원(${quarter} 시작 시점 잔액). ` +
      `분기 흐름=CF ${MONTHS[s.period]}개월 누적÷${n}. 한계: ${limitations.join(" ")}`,
    1000,
  );
  const quarterRationale = clip(
    `분기 값=${s.fiscalYear} ${s.period} 누적÷${n}: 설비투자(${names(capexRows)}) ${fmt(q(capexYtd))}, D&A ${daRows.length ? `(${names(daRows)}) ${fmt(da)}` : "별도 행 없음"}, ` +
      `운전자본 증가${wcYtd === null ? " 별도 산출 불가" : `((${wcUsed.join("+")}) 기말-전기말) ${fmt(dWc)}`}, 법인세 ${fmt(q(sumYtd(taxRows)))}, 이자 ${fmt(q(sumYtd(interestRows)))}, ` +
      `원금 상환(1년 내 만기 ${fmt(currentDebt)}÷4, 균등 만기 가정·차환 없음) ${fmt(principal)}, 배당·자사주·신종자본 이자(${payoutRows.length ? names(payoutRows) : "행 없음"}) ${fmt(q(sumYtd(payoutRows)))}, 확약 신규 차입 0(확약 근거 없음).`,
    1000,
  );
  const otherRationale = clip(
    `영업에서 창출된 현금 누적 ${fmt(cgoYtd)} - 영업이익 누적 ${fmt(opYtd)} - D&A ${fmt(daYtd)} + 운전자본 증가 ${fmt(wcYtd ?? 0)} = 잔차(계약부채·충당부채 등 기타 조정)의 분기 평균. 전망 영업이익과 합해 과거 영업창출현금 전환 수준을 유지.`,
    500,
  );

  const parsed = SingleQuarterFundingPlanSchema.safeParse({
    openingBalanceBasis: "projected_start_of_horizon",
    openingUnrestrictedCashKRW: openingCash,
    openingDebtKRW: openingDebt,
    assumptions: { isAssumption: true, rationale: planRationale, source },
    quarters: [{
      quarter,
      depreciationAndAmortizationKRW: da,
      capexKRW: q(capexYtd),
      deltaWorkingCapitalKRW: dWc,
      cashTaxesKRW: q(sumYtd(taxRows)),
      cashInterestPaidKRW: q(sumYtd(interestRows)),
      otherOperatingCashFlowKRW: other,
      otherOperatingCashFlowRationale: otherRationale,
      debtPrincipalDueKRW: principal,
      committedDebtDrawKRW: 0,
      dividendsAndBuybacksKRW: q(sumYtd(payoutRows)),
      assumptions: { isAssumption: true, rationale: quarterRationale, source },
    }],
  });
  if (!parsed.success)
    return unavailable("FUNDING_DERIVATION_INVALID", `공시 기반 자금 계획이 스키마 검증에 실패했습니다: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 3).join("; ")}`);
  return {
    status: "derived", plan: parsed.data, statement: { rceptNo: s.rceptNo, period: `${s.fiscalYear} ${s.period}`, periodEnd: s.periodEnd, url: s.receiptUrl }, limitations,
    noRefinancing: { currentDebtKRW: currentDebt, assumedPrincipalDueKRW: principal },
    restrictedCash: { status: restrictedKRW > 0 ? "deducted" : "not_found_in_collected_evidence", deductedKRW: restrictedKRW },
  };
}

type DebtRow = StatementRow & { thisTermAmount: number };
/** Splits interest-bearing debt rows into current / non-current, refusing anything that could double count: a row
 * that looks like a total or sub-total of the others, a row whose maturity bucket cannot be read from its
 * name/account id, or the same account appearing twice. */
function classifyDebt(rows: StatementRow[]): { current: DebtRow[]; noncurrent: DebtRow[] } | { error: string } {
  const withAmount = rows.filter((r): r is DebtRow => r.thisTermAmount !== null);
  const bad = withAmount.find((r) => !krw(r) || r.thisTermAmount < 0);
  if (bad) return { error: `'${bad.accountName}' 금액/통화를 원화 잔액으로 쓸 수 없습니다.` };
  const ids = withAmount.map((r) => r.accountId).filter((id) => id && !/표준계정코드\s*미사용/.test(id));
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) return { error: `같은 계정(${dup})이 두 번 이상 있어 합계·세부 중복 여부를 알 수 없습니다.` };
  const total = withAmount.find((r) => /합계|총계|총\s*차입|계$|ifrs-full_Borrowings$/.test(label(r).replace(/\s+\S+$/, "")) || /ifrs-full_Borrowings$/.test(r.accountId));
  if (total && withAmount.length > 1) return { error: `합계로 보이는 '${total.accountName}' 행과 세부 행이 함께 있습니다.` };
  // A row equal to the sum of two or more other rows is treated as a sub-total, whatever its name.
  for (const r of withAmount) {
    const others = withAmount.filter((o) => o !== r);
    if (others.length >= 2 && Math.abs(others.reduce((a, o) => a + o.thisTermAmount, 0) - r.thisTermAmount) < 1)
      return { error: `'${r.accountName}' 금액이 다른 차입 행들의 합과 같아 합계 행으로 의심됩니다.` };
  }
  const current: DebtRow[] = [];
  const noncurrent: DebtRow[] = [];
  for (const r of withAmount) {
    const l = label(r);
    if (/비유동|Noncurrent|NonCurrent/.test(l)) noncurrent.push(r);
    else if (/단기|유동성|유동\s*(차입|사채)|Shortterm|ShortTerm|Current/.test(l)) current.push(r);
    else if (/장기|Longterm|LongTerm|^사채|BondsIssued/.test(l)) noncurrent.push(r);
    else return { error: `'${r.accountName}'(${r.accountId || "계정코드 없음"})의 유동/비유동 구분을 알 수 없습니다.` };
  }
  return { current, noncurrent };
}
