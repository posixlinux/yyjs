import type { CompetitorPeriod } from "./types.js";

const DAY = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);
const quarterOf = (t: number) => {
  const d = new Date(t);
  return { label: `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`, end: Date.UTC(d.getUTCFullYear(), (Math.floor(d.getUTCMonth() / 3) + 1) * 3, 0) };
};

/**
 * Calendar label of a fiscal period. A quarter is the calendar quarter holding most of it ("2025Q2"); a half-year or
 * year is the range of calendar quarters it covers ("2025Q2~2025Q3" for an Apr-Sep half), since fiscal halves and
 * years often do not line up with calendar ones. "exact" when periodEnd is within 7 days of a calendar quarter end.
 */
export function calendarPeriodOf(periodEnd: string, months: 3 | 6 | 12): Pick<CompetitorPeriod, "calendarPeriod" | "calendarAlignment"> {
  const end = utc(periodEnd);
  const last = quarterOf(end - 45 * DAY); // the quarter holding most of the final three months
  const first = quarterOf(end - (months * 30.44 - 45) * DAY);
  const calendarPeriod = months === 3 ? last.label : `${first.label}~${last.label}`;
  return { calendarPeriod, calendarAlignment: Math.abs(end - last.end) <= 7 * DAY ? "exact" : "approximate" };
}
