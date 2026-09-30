import type { Analysis } from "../model/model.js";
import type { AnalysisResult } from "../intelligence/types.js";

// Deterministic, numbers-only summary of a finished analysis: what the market size is (and whether it was read or
// inferred), how company + competitors + others add up to it, what the scenarios say, and how much of it is estimated.
// Nothing here calls a model; every figure comes from the analysis object.

const KRW_UNITS = (n: number): string => {
  const a = Math.abs(n);
  const s = n < 0 ? "-" : "";
  if (a >= 1e12) return `${s}${(a / 1e12).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}조`;
  if (a >= 1e8) return `${s}${(a / 1e8).toLocaleString("ko-KR", { maximumFractionDigits: 0 })}억`;
  return `${s}${Math.round(a).toLocaleString("ko-KR")}`;
};
const money = (n: number, ccy: string) => `${KRW_UNITS(n)}${ccy === "KRW" ? "원" : ` ${ccy}`}`;
const pct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`;

export function buildReport(a: Analysis, research?: Pick<AnalysisResult, "narrative" | "estimates" | "crossChecked" | "audit" | "unavailable" | "status"> | null) {
  const base = a.scenarios.find((s) => s.scenario === "base")!;
  const prices = a.scenarios.map((s) => ({ scenario: s.scenario, targetPriceKRW: s.valuation.status === "available" ? s.valuation.targetPriceKRW : null, upsidePct: s.valuation.status === "available" ? s.valuation.upsidePct : null, annualizedEpsKRW: s.valuation.status === "available" ? s.valuation.annualizedEpsKRW : null }));

  const estimates = a.dataQuality.estimates;
  const estimatedPaths = new Set(estimates.map((e) => e.path));

  const markets = a.facts.markets.map((m, mi) => {
    const proj = Object.fromEntries(a.scenarios.map((s) => [s.scenario, s.products.find((p) => p.marketId === m.id)]));
    const b = proj.base!;
    const latestEstimated = estimatedPaths.has(`markets[${mi}].observations[${m.observations.length - 1}].revenue`);
    const est = estimates.find((e) => e.path === `markets[${mi}].observations[${m.observations.length - 1}].revenue`);
    return {
      marketId: m.id,
      name: m.name,
      scope: m.scope,
      currency: m.currency,
      latestObserved: { quarter: m.observedLatest.quarter, revenue: m.observedLatest.revenue, estimated: latestEstimated, method: est?.method ?? null, rationale: est?.rationale ?? null, qoqPct: m.observedLatest.qoqPct, yoyPct: m.observedLatest.yoyPct },
      estimatedQuarters: m.observations.filter((_, j) => estimatedPaths.has(`markets[${mi}].observations[${j}].revenue`)).map((o) => o.quarter),
      projected: { quarter: a.targetQuarter, bear: proj.bear?.marketRevenue ?? null, base: proj.base?.marketRevenue ?? null, bull: proj.bull?.marketRevenue ?? null },
      projectedVsLatestPct: b.marketVsLatestObservedPct,
    };
  });

  const players = a.facts.marketStructureObserved.map((o) => {
    const projected = Object.fromEntries(
      a.scenarios.map((s) => {
        const p = s.products.find((x) => x.marketId === o.marketId)!;
        const st = p.structure;
        return [
          s.scenario,
          {
            marketRevenue: st.marketRevenue,
            company: st.company,
            competitors: st.competitors.map((c) => ({ name: c.name, share: c.share, marketRevenue: c.marketRevenue, estimated: c.estimated })),
            others: st.others,
            identifiedShare: st.identifiedShare,
            competitorsScaled: st.competitorsScaled,
            bottomUpBeforeScalingPct: st.bottomUpBeforeScalingPct,
            partsSumGapPct: (st.partsSumMarketRevenue / st.marketRevenue - 1) * 100,
          },
        ];
      }),
    );
    const known = o.company.revenue + o.competitors.reduce((t, c) => t + c.revenue, 0);
    return { marketId: o.marketId, currency: o.currency, observed: { ...o, partsSumGapPct: o.marketRevenue ? ((known + o.others.revenue) / o.marketRevenue - 1) * 100 : 0 }, projected };
  });

  const maxGapPct = Math.max(0, ...players.flatMap((p) => [Math.abs(p.observed.partsSumGapPct), ...Object.values(p.projected).map((s) => Math.abs(s.partsSumGapPct))]));
  const overshoot = players.flatMap((p) => Object.values(p.projected).filter((s) => s.competitorsScaled).map(() => p.marketId));

  const g = a.dataQuality.groundedness;
  // Qualitative grade of how much of the revenue data was READ from sources (not a probability or a confidence level).
  const knowledgeOnly = estimates.filter((e) => e.method === "model_knowledge").length;
  const dataGrounding: "high" | "medium" | "low" = g.groundedRatio >= 0.8 && knowledgeOnly === 0 ? "high" : g.groundedRatio >= 0.5 ? "medium" : "low";
  const swings = markets.filter((m) => m.latestObserved.estimated && m.latestObserved.qoqPct !== null && Math.abs(m.latestObserved.qoqPct) > 30);
  const quality = {
    dataGrounding,
    knowledgeOnlyEstimates: knowledgeOnly,
    implausibleEstimatedSwings: swings.map((m) => ({ marketId: m.marketId, quarter: m.latestObserved.quarter, qoqPct: m.latestObserved.qoqPct })),
    estimatedInputs: g.estimated,
    totalInputs: g.total,
    groundedRatio: g.groundedRatio,
    estimates,
    crossChecked: research?.crossChecked ?? null,
    auditedBy: research?.audit.auditedBy ?? null,
    independentAudit: research?.audit.independentAudit ?? null,
    unavailableProviders: research?.unavailable?.map((u) => ({ provider: u.provider, code: u.code, retryAfter: u.retryAfter })) ?? [],
    adjustments: a.dataQuality.adjustments,
    warnings: a.dataQuality.warnings,
  };

  // ---- Korean summary lines --------------------------------------------------------------------------------------
  const lines: string[] = [];
  const bp = prices.find((p) => p.scenario === "base")!;
  const range = prices.filter((p) => p.targetPriceKRW !== null).map((p) => p.targetPriceKRW!);
  lines.push(
    bp.targetPriceKRW !== null
      ? `${a.companyName}(${a.ticker}) ${a.targetQuarter} 기준 base 목표가(밸류에이션 프록시) ${money(bp.targetPriceKRW, "KRW")}, 현재가 대비 ${bp.upsidePct! >= 0 ? "+" : ""}${bp.upsidePct!.toFixed(1)}%${range.length > 1 ? ` (bear~bull ${money(Math.min(...range), "KRW")} ~ ${money(Math.max(...range), "KRW")})` : ""}.`
      : `${a.companyName}(${a.ticker}) ${a.targetQuarter}: base 시나리오의 보통주 귀속이익이 양수가 아니어서 목표가를 산출하지 못했습니다.`,
  );
  for (const m of markets) {
    const l = m.latestObserved;
    lines.push(
      `시장 "${m.name}": 최근 ${l.quarter} 규모 ${money(l.revenue, m.currency)} (${l.estimated ? `추정 — ${l.method}` : "출처에서 확인"}${l.qoqPct !== null ? `, 전분기 대비 ${l.qoqPct >= 0 ? "+" : ""}${l.qoqPct.toFixed(1)}%` : ""}); ${m.projected.quarter} 전망 base ${money(m.projected.base ?? 0, m.currency)}${m.projected.bear && m.projected.bull ? ` (bear ${money(m.projected.bear, m.currency)} ~ bull ${money(m.projected.bull, m.currency)})` : ""}.`,
    );
  }
  for (const p of players) {
    const o = p.observed;
    const names = o.competitors.map((c) => `${c.name} ${pct(c.share)}${c.estimated ? "(추정)" : ""}`).join(", ");
    lines.push(
      `${o.quarter} 업체 구성: 회사 ${pct(o.company.share)}${o.company.estimated ? "(추정)" : ""}${names ? `, ${names}` : ""}, 기타 ${pct(o.others.share)} — 합계 = 시장 규모(편차 ${o.partsSumGapPct.toFixed(2)}%); 파악된 업체가 시장의 ${pct(o.identifiedCoverage, 0)}.`,
    );
    const pb = p.projected.base!;
    lines.push(
      `${a.targetQuarter} base 전망: 회사 ${pct(pb.company.share)}, 경쟁사 ${pb.competitors.map((c) => `${c.name} ${pct(c.share)}`).join(", ") || "없음"}, 기타 ${pct(pb.others.share)} → 합계가 전망 시장 규모와 일치${pb.competitorsScaled ? " (경쟁사 점유율이 남은 몫에 맞게 축소됨)" : ""}.`,
    );
  }
  if (swings.length) lines.push(`경고: 추정한 시장 규모가 전분기 대비 ${swings.map((m) => `${m.name} ${m.latestObserved.qoqPct! >= 0 ? "+" : ""}${m.latestObserved.qoqPct!.toFixed(0)}%`).join(", ")} 변동합니다 — 추정 방법과 단위를 반드시 검토하세요.`);
  if (g.estimated) lines.push(`주의: 매출 입력 ${g.total}개 중 ${g.estimated}개(${((1 - g.groundedRatio) * 100).toFixed(0)}%)가 출처에서 읽은 값이 아니라 다른 데이터로 추론한 추정치입니다. 결과는 그 불확실성을 그대로 물려받습니다(데이터 근거 수준: ${{ high: "높음", medium: "보통", low: "낮음" }[dataGrounding]}${knowledgeOnly ? `, 문서 없이 배경지식만으로 만든 추정 ${knowledgeOnly}건 포함` : ""}).`);
  if (research) {
    if (research.crossChecked) lines.push("검토: Claude와 agy가 서로 독립적으로 교차검증했습니다.");
    else if (research.audit.auditedBy) lines.push(`검토: ${research.audit.auditedBy} 단일 모델이 초안과 별도 호출로 자체 감사했습니다(독립 교차검증 아님).`);
    else lines.push("검토: 모델 감사 없이 결정론적 검사(인용·숫자·날짜·추정 규칙)만 통과했습니다.");
  }
  if (overshoot.length) lines.push(`참고: ${[...new Set(overshoot)].join(", ")} 시장에서 이름이 확인된 경쟁사 몫이 100%를 넘어 자동으로 축소되었습니다.`);

  return {
    headline: lines[0]!,
    valuation: { targetQuarter: a.targetQuarter, currentPriceKRW: a.facts.quote.priceKRW, scenarios: prices },
    markets,
    players,
    reconciliation: { maxPartsSumGapPct: maxGapPct, allPartsSumToMarket: maxGapPct < 0.01, competitorsScaledInMarkets: [...new Set(overshoot)] },
    quality,
    narrative: research?.narrative ?? null,
    lines,
    base: { revenueKRW: base.totals.revenueKRW, operatingProfitKRW: base.totals.operatingProfitKRW },
  };
}
export type Report = ReturnType<typeof buildReport>;
