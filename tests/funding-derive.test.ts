import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { StatementSet } from "../src/collection/types.js";
import { deriveFundingPlan } from "../src/strategy/funding-derive.js";

// Real public DART rows (Hanwha Aerospace 012450, 2025 Q3 consolidated, fnlttSinglAcntAll), funding-relevant subset.
const REAL: StatementSet = JSON.parse(readFileSync(new URL("./fixtures/dart-012450-2025Q3-cfs.json", import.meta.url), "utf8"));
const DOCS = [{ url: REAL.receiptUrl, publishedAt: "2025-11-13" }];

describe("deriveFundingPlan (statement-derived funding plan)", () => {
  it("derives the start-of-quarter balances and YTD/3 quarterly flows from a real 9-month consolidated statement", () => {
    const d = deriveFundingPlan([REAL], DOCS, "2025Q4");
    if (d.status !== "derived") throw new Error(d.message);
    const p = d.plan;
    const q = p.quarters[0]!;
    expect(p.openingUnrestrictedCashKRW).toBe(4_244_476_069_000);
    expect(p.openingDebtKRW).toBe(7_569_521_034_000 + 4_438_986_116_000); // 차입금및사채 current + non-current, leases excluded
    expect(q.quarter).toBe("2025Q4");
    expect(q.capexKRW).toBeCloseTo((873_772_782_000 + 191_369_077_000) / 3, 0);
    expect(q.cashTaxesKRW).toBeCloseTo(477_858_642_000 / 3, 0);
    expect(q.cashInterestPaidKRW).toBeCloseTo(337_705_133_000 / 3, 0);
    // no refinancing: current (<=12m) borrowings are repaid, evenly over four quarters (labelled assumption)
    expect(q.debtPrincipalDueKRW).toBeCloseTo(7_569_521_034_000 / 4, 0);
    expect(d.noRefinancing).toEqual({ currentDebtKRW: 7_569_521_034_000, assumedPrincipalDueKRW: 7_569_521_034_000 / 4 });
    expect(q.assumptions.rationale).toContain("균등 만기 가정·차환 없음");
    expect(q.dividendsAndBuybacksKRW).toBeCloseTo((195_060_310_000 + 17_496_242_000) / 3, 0); // dividends + hybrid coupon, not dividends received
    const wc = (3_497_009_793_000 - 3_377_790_242_000) + (7_877_825_945_000 - 6_290_309_306_000) - (4_560_548_383_000 - 4_269_928_224_000);
    expect(q.deltaWorkingCapitalKRW).toBeCloseTo(wc / 3, 0);
    // reconciles to reported cash generated from operations: OP + D&A - dWC + other = CGO (per quarter)
    expect(q.otherOperatingCashFlowKRW).toBeCloseTo((637_888_897_000 - 2_281_693_091_000 + wc) / 3, 0);
    expect(q.depreciationAndAmortizationKRW).toBe(0);
    expect(q.committedDebtDrawKRW).toBe(0);
    expect(p.assumptions.source).toEqual({ title: expect.stringContaining("20251113000661"), url: REAL.receiptUrl, kind: "filing", knownAt: "2025-11-13T00:00:00+09:00" });
    expect(p.assumptions.rationale).toContain("모델 추정 아님");
    expect(d.limitations.join(" ")).toContain("감가상각비 행이 없어"); // an absent row is disclosed, not silently zero
    // no restricted-cash disclosure was collected: an explicit assumption, not a verified zero
    expect(d.restrictedCash).toEqual({ status: "not_found_in_collected_evidence", deductedKRW: 0 });
    expect(p.assumptions.rationale).toContain("사용제한 현금 표시를 찾지 못해");
    expect(p.assumptions.rationale).toContain("제한 금액 0이 확인된 것은 아니며");
  });

  const bsRow = (accountName: string, accountId: string, amount: number) => ({ statement: "BS" as const, accountName, accountId, currency: "KRW", thisTermLabel: null, thisTermAmount: amount,
    thisTermCumulativeAmount: null, priorTermLabel: null, priorTermAmount: null, priorQuarterLabel: null, priorQuarterAmount: null, priorCumulativeAmount: null });
  const withRows = (...extra: ReturnType<typeof bsRow>[]): StatementSet => ({ ...REAL, rows: [...REAL.rows, ...extra] });

  it.each([
    ["a named total next to its detail rows", bsRow("차입금 합계", "-표준계정코드 미사용-", 12_008_507_150_000)],
    ["an unnamed sub-total equal to the sum of the detail rows", bsRow("차입금및사채", "-표준계정코드 미사용-", 12_008_507_150_000)],
    ["the same account id twice", bsRow("차입금및사채", "ifrs-full_ShorttermBorrowings", 7_569_521_034_000)],
    ["a borrowing row whose maturity bucket is unknown", bsRow("기타차입금", "-표준계정코드 미사용-", 1_000_000)],
  ])("refuses to sum debt when rows could double count: %s", (_why, extra) => {
    const d = deriveFundingPlan([withRows(extra)], DOCS, "2025Q4");
    expect(d).toMatchObject({ status: "unavailable", code: "FUNDING_DEBT_ROWS_AMBIGUOUS" });
  });

  it("deducts restricted cash only when it is stated as part of cash and cash equivalents", () => {
    const d = deriveFundingPlan([withRows(bsRow("사용제한 현금및현금성자산", "-표준계정코드 미사용-", 244_476_069_000))], DOCS, "2025Q4");
    if (d.status !== "derived") throw new Error(d.message);
    expect(d.plan.openingUnrestrictedCashKRW).toBe(4_000_000_000_000);
    expect(d.restrictedCash).toEqual({ status: "deducted", deductedKRW: 244_476_069_000 });
  });

  it("is unavailable when restricted deposits are disclosed but their overlap with cash cannot be resolved", () => {
    const row = deriveFundingPlan([withRows(bsRow("사용제한예금", "-표준계정코드 미사용-", 5_000_000_000))], DOCS, "2025Q4");
    expect(row).toMatchObject({ status: "unavailable", code: "FUNDING_RESTRICTED_CASH_UNRESOLVED" });
    const note = deriveFundingPlan([REAL], DOCS, "2025Q4", [{ rceptNo: REAL.rceptNo, sectionTitle: "사용이 제한된 금융상품", text: "현금및현금성자산 중 담보로 제공된 예금 1,200 백만원" }]);
    expect(note).toMatchObject({ status: "unavailable", code: "FUNDING_RESTRICTED_CASH_UNRESOLVED" });
    // a note of a DIFFERENT filing does not describe this balance sheet
    expect(deriveFundingPlan([REAL], DOCS, "2025Q4", [{ rceptNo: "20200101000001", sectionTitle: "사용이 제한된 금융상품", text: "x" }]).status).toBe("derived");
  });

  it("refuses to carry balances across an unreported stub period", () => {
    const d = deriveFundingPlan([REAL], DOCS, "2026Q1");
    expect(d).toMatchObject({ status: "unavailable", code: "FUNDING_OPENING_BALANCE_UNAVAILABLE" });
    if (d.status === "unavailable") expect(d.message).toContain("2025-12-31");
  });

  it("never mixes in separate (OFS) statements", () => {
    const d = deriveFundingPlan([{ ...REAL, fsDiv: "OFS" }], DOCS, "2025Q4");
    expect(d).toMatchObject({ status: "unavailable", code: "FUNDING_OPENING_BALANCE_UNAVAILABLE" });
  });

  it("requires the statement to be one of the documents actually supplied as evidence", () => {
    expect(deriveFundingPlan([REAL], [], "2025Q4")).toMatchObject({ status: "unavailable", code: "FUNDING_SOURCE_NOT_SUPPLIED" });
  });

  it("does not replace a missing required row (cash generated from operations) with zero", () => {
    const rows = REAL.rows.filter((r) => !/창출된/.test(r.accountName));
    const d = deriveFundingPlan([{ ...REAL, rows }], DOCS, "2025Q4");
    expect(d).toMatchObject({ status: "unavailable", code: "FUNDING_STATEMENT_ROWS_MISSING" });
    if (d.status === "unavailable") expect(d.message).toContain("영업에서 창출된 현금");
  });
});
