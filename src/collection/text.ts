import { isValidDate } from "../domain/time.js";
import { CollectionInputError } from "./types.js";

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith("#")) {
      const cp = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      // control characters are dropped so they cannot forge our internal markers
      return cp >= 32 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

export const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
export const stripTags = (s: string): string => s.replace(/<[^>]*>/g, " ");
export const plainText = (s: string): string => collapse(decodeEntities(stripTags(s)));
export const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

export function parseAmount(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.replace(/,/g, "").trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

export const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

export const kstDate = (ms: number): string => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

/** "YYYYMMDDHHmm[ss]" (KST) -> ISO with +09:00, or null when malformed. */
export function naverDateTime(v: unknown): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/.exec(str(v));
  if (!m) return null;
  const [, y, mo, d, h, mi, s = "00"] = m as unknown as string[];
  const utc = new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s));
  if (utc.getUTCFullYear() !== +y! || utc.getUTCMonth() !== +mo! - 1 || utc.getUTCDate() !== +d! || +h! > 23 || +mi! > 59) {
    return null;
  }
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`;
}

export interface AsOf {
  input: string;
  cutoffMs: number;
  cutoff: string;
  dateKst: string; // YYYY-MM-DD
  dateOnly: boolean;
}

export function parseAsOf(input: string): AsOf {
  if (typeof input !== "string") throw new CollectionInputError("asOf must be a string");
  let cutoffMs: number;
  let dateOnly = false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    cutoffMs = Date.parse(`${input}T23:59:59.999+09:00`);
    dateOnly = true;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(input)) {
    cutoffMs = Date.parse(input);
  } else {
    throw new CollectionInputError("asOf must be YYYY-MM-DD or an ISO timestamp with timezone");
  }
  // Date.parse rolls impossible days over ("2026-02-30T10:00Z" -> March 2), so the calendar date is checked itself.
  if (Number.isNaN(cutoffMs) || !isValidDate(input.slice(0, 10)) || (dateOnly && kstDate(cutoffMs) !== input)) {
    throw new CollectionInputError("asOf is not a valid date");
  }
  return { input, cutoffMs, cutoff: new Date(cutoffMs).toISOString(), dateKst: kstDate(cutoffMs), dateOnly };
}

export function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  return Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)).then(() => out);
}
