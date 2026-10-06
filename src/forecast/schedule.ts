import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { seoulToday } from "../domain/time.js";
import type { ForecastService } from "./service.js";

// Optional daily routine (FORECAST_DAILY_KST=HH:MM): after the KRX close on weekdays, rank both exchanges (which logs
// every forecast) and score the whole log against the closes that followed, so a live track record builds up.

/** KST calendar date, minutes after midnight and weekday. */
const kst = (now: Date) => {
  const t = new Date(now.getTime() + 9 * 3_600_000);
  return { date: seoulToday(now), minutes: t.getUTCHours() * 60 + t.getUTCMinutes(), weekday: t.getUTCDay() };
};
const RETRY_MS = 30 * 60_000; // a day whose run failed everywhere is retried, at most every 30 minutes

export function parseDailyTime(v: string | undefined): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** True when today's (KST, Mon-Fri) run time has passed and today has not run yet. */
export function isDue(now: Date, at: number, lastRunDate: string | null): boolean {
  const k = kst(now);
  return k.weekday >= 1 && k.weekday <= 5 && k.minutes >= at && lastRunDate !== k.date;
}

export function startDailyForecasts(svc: ForecastService, o: { at: number; dir: string; now?: () => Date; log?: (msg: string) => void }) {
  let last: string | null = null;
  let retryAt = 0;
  let running = false;
  const tick = async () => {
    const now = (o.now ?? (() => new Date()))();
    if (running || now.getTime() < retryAt || !isDue(now, o.at, last)) return;
    running = true;
    try {
      const summary: Record<string, unknown> = { ranAt: now.toISOString() };
      let ranked = 0;
      for (const exchange of ["KOSPI", "KOSDAQ"] as const) {
        try {
          const r = await svc.rank({ exchange, count: 30, horizon: 1 });
          summary[exchange] = { ranked: r.ranked.length, pooledAccuracy: r.pooledBacktest.accuracy, edge: r.pooledBacktest.edge, failures: r.failures };
          ranked++;
        } catch (e) {
          summary[exchange] = { error: (e as Error).message };
        }
      }
      if (ranked) last = kst(now).date;
      else retryAt = now.getTime() + RETRY_MS;
      try {
        summary.score = (await svc.scoreLog()).summary;
      } catch (e) {
        summary.score = { error: (e as Error).message };
      }
      await mkdir(o.dir, { recursive: true }).then(() => writeFile(path.join(o.dir, "forecast-daily.json"), JSON.stringify(summary, null, 2))).catch(() => undefined);
      o.log?.(`daily forecasts ${ranked ? "done" : "failed (retrying in 30 min)"}: ${JSON.stringify(summary).slice(0, 300)}`);
    } catch {
      retryAt = now.getTime() + RETRY_MS;
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
