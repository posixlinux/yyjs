import { AppError } from "../errors.js";
import type { RiskPolicy } from "./config.js";
import { computeForecastBridge, type ForecastBridge } from "./earnings.js";
import type { EarningsForecastSnapshot, FundingPlan } from "./schema.js";

/** Funding scenario, not an audited cash-flow statement. D&A is assumed already charged in operating costs. */
export function computeFunding(bridge: ForecastBridge, plan: FundingPlan, policy: RiskPolicy, stressed = false) {
  if (bridge.quarters.some((q, i) => q.quarter !== plan.quarters[i]?.quarter))
    throw new AppError(422, "FUNDING_HORIZON_MISMATCH", "Funding plan must cover the exact forecast quarters");
  let cash = plan.openingUnrestrictedCashKRW;
  let debt = plan.openingDebtKRW;
  let minCash = cash;
  const quarters = bridge.quarters.map((q, i) => {
    const f = plan.quarters[i]!;
    const openingCashKRW = cash;
    const openingDebtKRW = debt;
    if (f.debtPrincipalDueKRW > debt + f.committedDebtDrawKRW)
      throw new AppError(422, "INVALID_DEBT_SCHEDULE", `Principal due exceeds debt plus committed draws in ${q.quarter}`);
    const incrementalInterestKRW = stressed ? debt * policy.annualInterestShockBps / 10000 / 4 : 0;
    const cashInterestPaidKRW = f.cashInterestPaidKRW + incrementalInterestKRW;
    const operatingCashProxyKRW = q.operatingProfitKRW + f.depreciationAndAmortizationKRW - f.cashTaxesKRW
      - cashInterestPaidKRW + f.otherOperatingCashFlowKRW - f.deltaWorkingCapitalKRW;
    const freeCashFlowAfterCapexKRW = operatingCashProxyKRW - f.capexKRW;
    cash += freeCashFlowAfterCapexKRW - f.debtPrincipalDueKRW + f.committedDebtDrawKRW - f.dividendsAndBuybacksKRW;
    debt += f.committedDebtDrawKRW - f.debtPrincipalDueKRW;
    minCash = Math.min(minCash, cash);
    return {
      openingCashKRW, openingDebtKRW,
      revenueKRW: q.revenueKRW, operatingProfitKRW: q.operatingProfitKRW,
      ...f, operatingCashProxyKRW, freeCashFlowAfterCapexKRW, cashInterestPaidKRW, incrementalInterestKRW,
      endingCashKRW: cash, endingDebtKRW: debt, netDebtKRW: debt - cash,
      additionalFundingRequiredKRW: Math.max(0, policy.minimumCashBufferKRW - cash),
      capexToRevenue: q.revenueKRW > 0 ? f.capexKRW / q.revenueKRW : null,
      interestCoverage: cashInterestPaidKRW > 0 ? q.operatingProfitKRW / cashInterestPaidKRW : null,
      interestCoverageReason: cashInterestPaidKRW > 0 ? null : "NO_CASH_INTEREST",
    };
  });
  return {
    quarters,
    minimumQuarterBoundaryCashKRW: minCash,
    peakAdditionalFundingRequiredKRW: Math.max(0, policy.minimumCashBufferKRW - minCash),
    totalCapexKRW: quarters.reduce((n, q) => n + q.capexKRW, 0),
    totalWorkingCapitalAbsorptionKRW: quarters.reduce((n, q) => n + q.deltaWorkingCapitalKRW, 0),
    totalFreeCashFlowAfterCapexKRW: quarters.reduce((n, q) => n + q.freeCashFlowAfterCapexKRW, 0),
    totalDebtRepaymentKRW: quarters.reduce((n, q) => n + q.debtPrincipalDueKRW, 0),
    totalCommittedBorrowingKRW: quarters.reduce((n, q) => n + q.committedDebtDrawKRW, 0),
    endingDebtKRW: debt, endingCashKRW: cash, endingNetDebtKRW: debt - cash,
  };
}

export function computeCompanyRisk(forecast: EarningsForecastSnapshot, policy: RiskPolicy) {
  if (!forecast.funding) return null;
  const plan = forecast.funding;
  const baseBridge = computeForecastBridge(forecast);
  const base = computeFunding(baseBridge, plan, policy);
  // Principal/draw schedule is held fixed. Opening debt determines incremental interest in BOTH bridges.
  let debt = plan.openingDebtKRW;
  const stressForecast: EarningsForecastSnapshot = {
    ...forecast,
    quarters: forecast.quarters.map((q, i) => {
      const extraInterest = debt * policy.annualInterestShockBps / 10000 / 4;
      debt += plan.quarters[i]!.committedDebtDrawKRW - plan.quarters[i]!.debtPrincipalDueKRW;
      return {
        ...q, netInterestKRW: q.netInterestKRW - extraInterest,
        segments: q.segments.map((s) => ({ ...s, volume: s.volume * (1 - policy.volumeDecline),
          unitPriceKRW: s.unitPriceKRW * (1 - policy.priceDecline),
          variableCostPerUnitKRW: s.variableCostPerUnitKRW * (1 + policy.variableCostIncrease) })),
      };
    }),
  };
  const stressBridge = computeForecastBridge(stressForecast);
  const stress = computeFunding(stressBridge, plan, policy, true);
  return {
    status: "estimated" as const,
    base: { ...base, fourQuarterEpsKRW: baseBridge.ntmEpsKRW, totalOperatingProfitKRW: baseBridge.quarters.reduce((n, q) => n + q.operatingProfitKRW, 0) },
    stress: { ...stress, fourQuarterEpsKRW: stressBridge.ntmEpsKRW, totalOperatingProfitKRW: stressBridge.quarters.reduce((n, q) => n + q.operatingProfitKRW, 0) },
    assumptions: { volumeDecline: policy.volumeDecline, priceDecline: policy.priceDecline, variableCostIncrease: policy.variableCostIncrease, annualInterestShockBps: policy.annualInterestShockBps },
    notes: [
      "Scenario estimates, not probabilities, VaR, audited cash flows or a bankruptcy prediction.",
      "Opening cash/debt are projected at the first forecast quarter's start; pre-horizon and intra-quarter liquidity are not modelled.",
      "D&A is already included in operating costs and added back once. Capex/principal reduce cash, not EPS again.",
      "Stress holds cash tax payments, D&A, fixed costs, capex, working-capital plan, committed financing and payouts fixed; no immediate tax refunds assumed.",
      "Rate shock assumes all quarter-opening debt reprices immediately. Fixed-rate debt/hedges are not distinguished.",
    ],
    unmodelledRisks: ["pre-horizon/intra-quarter funding", "FX", "tariffs", "credit spreads/covenants", "refinancing commitment failure", "execution gaps/liquidity freezes", "model error"],
  };
}
export type CompanyRisk = NonNullable<ReturnType<typeof computeCompanyRisk>>;
