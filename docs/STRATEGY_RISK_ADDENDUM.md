# User-requested extension: investment and risk, mandatory for this implementation

> Ownership update (2026-09-30): the user subsequently instructed Codex to implement directly. Codex completed the risk/review work; current behavior is documented in STRATEGY.md and ../IMPLEMENTATION_REPORT.md. Earlier Claude-only ownership wording below is historical.
>
> Correction (2026-09-30, supersedes the above): the user reversed ownership again -- Claude implements all further code changes, Codex reviews the logic. Separately, "Add explicit automotive sector exposure cap ... this is one-sector research, NOT diversified across sectors" below is REMOVED as a restriction: candidates now span any user-chosen sector, and `maxSectorWeight` applies independently per declared `forecast.sector` (min(maxWeightPerHolding, 1/selectedCount, maxSectorWeight/sameSectorCount) per name), so a diversified multi-sector portfolio is allowed and can invest well above 60% in total. See STRATEGY.md for current behavior.

The user explicitly added: "성과 뿐만 아니라 투자나 다른 위험 항목도 계산에 포함하도록 해줘" and "계속 진행해줘". Interpret investment as BOTH the company's capital investment/working-capital burden AND portfolio capital allocation. Codex owns the design; Claude implements. Read alongside STRATEGY_SPEC.md and STRATEGY_REVIEW_FINDINGS.md. This supersedes the first spec where needed. Do not merely list risks in prose: compute them and use important ones in eligibility/sizing. Keep it a bounded deterministic research experiment, no real trades.

## Company investment / funding bridge
Add risk/funding inputs to each forecast snapshot or tightly linked candidate, SAME four fiscal quarters and ticker, all sourced/assumption-labeled and knownAt <= forecast generation (future actuals cannot be used). Require risk inputs for the normal strategy config. Old product-market model stays untouched. Missing risk data means ineligible with explicit RISK_DATA_MISSING; never assume zero investment/debt. Tests/examples must reflect the new default. Schema version/strategy version must be coherent (not already released, updating v1 schema in this branch is fine, document it).

Company-level opening unrestricted cash and opening interest-bearing debt, and per-quarter:
- depreciationAndAmortizationKRW (already included in forecast operating costs: add back ONCE in cash bridge)
- capexKRW (cash capital investment; includes maintenance + growth total; do NOT subtract it again in EPS)
- deltaWorkingCapitalKRW (positive = cash tied up; negative = release)
- cashTaxesKRW (actual cash-tax ASSUMPTION, not inferred from accrual tax)
- cashInterestPaidKRW (gross cash expense, not netInterest from EPS)
- otherOperatingCashFlowKRW (explicit signed adjustments/income, named rationale; default cannot silently fill missing)
- debtPrincipalDueKRW, committedDebtDrawKRW, dividendsAndBuybacksKRW
Require nonnegative values except deltaWorkingCapital/otherOperatingCashFlow. Cap principal due at available opening debt+committed new borrowing, or reject inconsistent debt schedules. Forecast operating profit from earnings bridge is AFTER D&A, so:
  operatingCashProxy = operatingProfit + D&A - cashTaxes - cashInterestPaid + otherOperatingCashFlow - deltaWorkingCapital
  freeCashFlowAfterCapex = operatingCashProxy - capex
  endingCash = openingCash + freeCashFlowAfterCapex - debtPrincipalDue + committedDebtDraw - dividendsAndBuybacks
  endingDebt = openingDebt - debtPrincipalDue + committedDebtDraw
Carry cash/debt forward each quarter without injecting imaginary financing when negative. committed borrowing is an explicit claim with provenance, not all hoped-for refinancing. Negative cash = model funding shortfall, NOT automatically bankruptcy prediction. Name outputs as estimates/proxies (this is not a full cash-flow statement).
Compute each quarter and totals: capex/revenue; working-capital absorption; free cash flow; net debt; minimum projected cash; peak additional funding needed to maintain configured minimum cash buffer; EBIT/cash-interest coverage (null+reason if no interest, negatives retained); total committed borrowing and debt repayment. No percentage divide-by-zero/Infinity.

## Downside stress (fixed, user-visible assumptions)
Add config risk policy with explicit hypothetical parameters, not calibrated confidence bands. Proposed starting defaults: volume -10%, selling price -5%, variable unit cost +5%, additional annual cash interest +200bp on quarter-opening debt /4; minimum cash buffer >=0 explicitly supplied. Recompute the earnings bridge AND cash bridge coherently:
- Volume affects BOTH revenue and total variable cost; fixed costs and capex remain fixed.
- Stress operating profit feeds funding model; add incremental interest to both pretax EPS (subtract from netInterest) and cashInterestPaid exactly once.
- Keep supplied cash tax plan fixed in stress, clearly label as conservative timing assumption; don't invent immediate refunds.
- Keep D&A, working-capital plan, principal maturities/committed draws, payouts fixed unless explicitly configured; report these held-fixed assumptions.
Report base vs stress EPS, operating profit, free cash flow, minimum cash, and funding gap. Optional fixed-PER diagnostic can report stress value and loss versus current price, explicitly a scenario, never a loss probability or VaR.
Normal eligibility excludes BASE funding gap > 0. Provide explicit config `excludeStressFundingGap` (default true for the initial conservative experiment); stress funding gap then also excludes. Explicit minimum interest-coverage gate may be configured; if used default 1 and no-interest = not applicable, not automatic failure. These are transparent experiment rules, not empirically optimal cutoffs. Don't discard capex-heavy businesses solely because free cash flow <0 if funding remains adequate; show the investment burden separately.

## Portfolio risks and investable size
- Never negative cash/leverage or duplicate ticker. Keep maxWeightPerHolding and maxHoldings.
- Add explicit automotive sector exposure cap (proposed default 60% of initial capital; this is one-sector research, NOT diversified across sectors). Cap each selected name at min(maxWeightPerHolding, maxSectorWeight / selectedCount); less than cap may remain cash. Ranking remains gap then ticker, independent of future prices.
- Add optional observed trailing average daily traded value in KRW with window sessions, asOf/knownAt and source; strict time check <=decision. If liquidity-required policy enabled (default true for investable screen), missing values => LIQUIDITY_DATA_MISSING. Size each order budget <= avgDailyTradedValueKRW * maxParticipationRate (proposed 1%); leave remainder cash, no redistribution that breaks caps. State this is a capacity estimate, not guaranteed fill. No trading volume outcome from holding period can be used here.
- Report invested amount, idle cash, per-name weights, sector exposure, largest position, participation estimates, and optional weighted stress valuation loss for positions with comparable diagnostics. If diagnostics are missing, don't invent portfolio stress loss; report coverage/unavailable explicitly.
- Existing realized net return/max drawdown/benchmark comparison still retained. Add turnover and cash-weighted sector benchmark as a diagnostic if straightforward; keep full-index comparison too.
- FX, credit spread, tariffs, execution gaps, liquidity freezes and model error are NOT fully modeled by price/volume/cost stress. Output coverage lists (computed vs unmodeled) rather than claiming comprehensive risk measurement. No arbitrary "risk score 87" or probabilities.

## Acceptance tests and docs
1. Profitable EPS company with high capex and maturity wall -> positive funding gap -> excluded.
2. Same profitability with sufficient cash/committed debt -> no fabricated funding gap; capex doesn't reduce EPS twice.
3. Positive working-capital delta reduces cash; negative increases cash; D&A added once; repay principal changes cash/debt not EPS; financing increases debt/cash not profit.
4. Stress volume scales variable cost; rate shock affects EPS and cash once; stress-only funding gap obeys configured gate; interest-free/zero denominators yield null+reason not Infinity.
5. Sector/position caps and liquidity reduce actual budget; cash remains; missing liquidity/risk inputs produce explicit exclusions; future liquidity source rejected.
6. All time/provenance/forward-vs-retrospective fixes from review still apply; same-accounting oracle under a permissive explicit test config remains true.
7. Update examples/API/CLI/Korean docs and final implementation report. Clearly mark synthetic risk scenarios and hypothesis thresholds as unvalidated, not real financial evidence.
