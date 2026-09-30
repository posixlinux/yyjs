import type { HttpClient } from "./http.js";
import { CollectionError } from "./types.js";
import type { FxRate } from "./types.js";
import { asRecord, str } from "./text.js";
import type { AsOf } from "./text.js";

// ECB euro foreign-exchange reference rates, served by the keyless Frankfurter API (https://frankfurter.dev). One
// request per run: EUR-based rates for KRW and the common market currencies, crossed to KRW per unit.
const API = "https://api.frankfurter.dev/v1";
/** Market currencies offered to the models (all in the ECB basket; TWD is not). */
export const FX_CURRENCIES = ["USD", "EUR", "JPY", "CNY", "GBP", "HKD", "CHF", "SGD"] as const;
const DECIMALS = 4;

/**
 * KRW per unit for FX_CURRENCIES on the last ECB business day ON OR BEFORE the day before asOf (KST). The ECB fixes at
 * ~16:00 CET, i.e. before midnight KST of the same day, so asOf-1 is always published before the asOf date begins.
 */
export async function collectFx(c: { asOf: AsOf; http: HttpClient; ttlMs: number }): Promise<FxRate[]> {
  const day = new Date(Date.parse(`${c.asOf.dateKst}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const symbols = ["KRW", ...FX_CURRENCIES.filter((x) => x !== "EUR")].join(",");
  const url = `${API}/${day}?base=EUR&symbols=${symbols}`;
  const raw = asRecord(await c.http.json(url, { ttlMs: c.ttlMs, disk: { key: `fx:ecb:${day}:${symbols}`, ttlMs: Infinity, validate: (b) => /"rates"/.test(b.toString("utf8")) } }));
  return parseFx(raw, day, url);
}

export function parseFx(raw: Record<string, unknown> | null, requestedDay: string, url: string): FxRate[] {
  const date = str(raw?.date);
  const rates = asRecord(raw?.rates);
  if (str(raw?.base) !== "EUR" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !rates)
    throw new CollectionError("invalid_response", "FX reference-rate response has no EUR base, date or rates");
  if (date > requestedDay) throw new CollectionError("invalid_response", `FX reference rate dated ${date} is after the requested ${requestedDay}`);
  const krw = Number(rates.KRW);
  if (!Number.isFinite(krw) || krw <= 0) throw new CollectionError("invalid_response", "FX reference-rate response has no KRW rate");
  const round = (n: number) => Number(n.toFixed(DECIMALS));
  const out: FxRate[] = [];
  for (const cur of FX_CURRENCIES) {
    const perEur = cur === "EUR" ? 1 : Number(rates[cur]);
    if (!Number.isFinite(perEur) || perEur <= 0) continue;
    out.push({ currency: cur, krwPerUnit: round(krw / perEur), rateDate: date, source: "ECB euro foreign exchange reference rates (via Frankfurter API), crossed through EUR", sourceUrl: url });
  }
  return out;
}
