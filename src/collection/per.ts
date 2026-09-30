import type { DailyClose, PerReference, QuarterlyActual } from "./types.js";

const qIndex = (q: string) => Number(q.slice(0, 4)) * 4 + Number(q.slice(5)) - 1;

/**
 * Trailing PER reference: latest close / sum of the latest four CONSECUTIVE reported quarterly EPS values, plus the
 * range of the collected closes divided by that same TTM EPS. Null when four consecutive quarters are not available
 * or the TTM EPS is not positive (a PER is meaningless on a loss).
 */
export function perReference(closes: DailyClose[], actuals: QuarterlyActual[], sourceUrls: string[]): PerReference | null {
  const q = [...actuals].sort((a, b) => a.quarter.localeCompare(b.quarter)).slice(-4);
  if (q.length < 4 || !closes.length) return null;
  for (let i = 1; i < 4; i++) if (qIndex(q[i]!.quarter) !== qIndex(q[i - 1]!.quarter) + 1) return null;
  const ttm = q.reduce((s, x) => s + x.epsKRW, 0);
  if (!(ttm > 0)) return null;
  const byDate = [...closes].sort((a, b) => a.date.localeCompare(b.date));
  const latest = byDate.at(-1)!;
  const pers = byDate.map((c) => c.closeKRW / ttm).sort((a, b) => a - b);
  const mid = pers.length >> 1;
  const median = pers.length % 2 ? pers[mid]! : (pers[mid - 1]! + pers[mid]!) / 2;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    ttmEpsKRW: r2(ttm),
    quarters: q.map((x) => x.quarter),
    latestClose: { date: latest.date, closeKRW: latest.closeKRW },
    current: r2(latest.closeKRW / ttm),
    window: { from: byDate[0]!.date, to: latest.date, sessions: byDate.length, min: r2(pers[0]!), median: r2(median), max: r2(pers.at(-1)!) },
    sourceUrls,
  };
}
