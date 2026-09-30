import type { CompetitorPeriod } from "./types.js";

const DAY = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Calendar quarter / half / year that holds most of the period (its midpoint), and whether the ends line up. */
export function calendarPeriodOf(periodEnd: string, months: 3 | 6 | 12): Pick<CompetitorPeriod, "calendarPeriod" | "calendarAlignment"> {
  const end = utc(periodEnd);
  const mid = new Date(end - months * 15.2 * DAY);
  const y = mid.getUTCFullYear();
  const slot = Math.floor(mid.getUTCMonth() / months); // index of the calendar quarter/half/year
  const label = months === 3 ? `${y}Q${slot + 1}` : months === 6 ? `${y}H${slot + 1}` : `${y}`;
  const calEnd = Date.UTC(y, (slot + 1) * months, 0);
  return { calendarPeriod: label, calendarAlignment: Math.abs(end - calEnd) <= 7 * DAY ? "exact" : "approximate" };
}
