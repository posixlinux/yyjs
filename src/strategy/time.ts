import { formatQuarter, quarterOfDate } from "../domain/time.js";

// Strategy inputs are timestamped with full ISO 8601 datetimes (explicit UTC offset), never bare dates, because
// eligibility depends on same-day ordering of knownAt/generatedAt/decisionAt events. All comparisons use epoch
// milliseconds (Date.parse), never string comparison: two equal instants written with different offsets
// ("2026-01-15T09:00:00+09:00" vs "2026-01-15T00:00:00Z") must compare equal.

const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const isValidIsoDateTime = (s: string): boolean => {
  if (!ISO_OFFSET.test(s)) return false;
  const date = s.slice(0, 10);
  const midnight = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== date) return false;
  const t = Date.parse(s);
  return Number.isFinite(t);
};

/** Epoch milliseconds of an ISO datetime already validated by isValidIsoDateTime. */
export const epoch = (iso: string): number => Date.parse(iso);

/** Whole days between two ISO instants (b - a), fractional days truncated toward zero. */
export const daysBetweenInstants = (a: string, b: string): number => (epoch(b) - epoch(a)) / 86_400_000;

/** UTC calendar date (YYYY-MM-DD) of an ISO instant; used only for quarter-end comparisons, never for ordering. */
export const calendarDateOf = (iso: string): string => new Date(epoch(iso)).toISOString().slice(0, 10);

/** The strategy's fiscal calendar is Korea's calendar, including at UTC quarter boundaries. */
export const seoulDateOf = (iso: string): string => new Date(epoch(iso) + 9 * 3600_000).toISOString().slice(0, 10);

/** The only quarters the automatic short-term path may estimate, given a KST decision date: the quarter that just
 * ended (its results are normally still unpublished for several weeks) and the quarter in progress. Either way the
 * estimated quarter ends, or its results are due, within about three months of the decision. */
export const singleQuarterHorizon = (decisionDate: string): { previous: string; current: string } => {
  const current = quarterOfDate(decisionDate);
  return { previous: formatQuarter(current - 1), current: formatQuarter(current) };
};
