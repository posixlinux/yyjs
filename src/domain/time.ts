// Quarter index = year * 4 + (quarter - 1). Index % 4 is the season slot (0 = Q1).

export const isValidDate = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export const parseQuarter = (q: string): number => Number(q.slice(0, 4)) * 4 + Number(q[5]) - 1;

export const formatQuarter = (i: number): string => `${Math.floor(i / 4)}Q${(i % 4) + 1}`;

export const quarterOfDate = (d: string): number =>
  Number(d.slice(0, 4)) * 4 + Math.floor((Number(d.slice(5, 7)) - 1) / 3);

/** Last calendar day of the quarter, YYYY-MM-DD. */
export const quarterEnd = (i: number): string =>
  new Date(Date.UTC(Math.floor(i / 4), ((i % 4) + 1) * 3, 0)).toISOString().slice(0, 10);

export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** Calendar date in Asia/Seoul (UTC+9, no DST): the default analysis date and the "future" cutoff. */
export const seoulToday = (now: Date): string => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
