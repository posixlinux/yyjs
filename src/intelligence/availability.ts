import type { ProviderName } from "./types.js";

// Expired-provider circuit breaker. A provider whose login/quota has expired (or whose CLI is missing) is skipped for
// a cooldown instead of being called again: the agy CLI, for example, retries a quota error for ~45 s before it gives
// up, so every analysis would otherwise wait that long for a certain failure. Process-wide, in memory.

/** Codes that mean "this provider cannot be used right now" (as opposed to a one-off failure such as a timeout). */
const EXPIRED_CODES = new Set(["QUOTA", "AUTH_REQUIRED", "CLI_NOT_FOUND"]);
export const isExpiredCode = (code: string): boolean => EXPIRED_CODES.has(code);

const MIN_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 24 * 3_600_000;
/** Used when the CLI does not say when the quota resets. Login problems are re-checked sooner: the operator may fix them. */
export const defaultCooldownMs = (code: string): number => (code === "QUOTA" ? 30 * 60_000 : 5 * 60_000);

/** "Resets in 17h9m35s" / "resets in 2 hours 5 minutes" -> milliseconds (undefined when not stated).
 *  Also reads a clock-time reset such as "resets 2:20pm" / "resets at 3pm" (observed session/weekly-limit phrasing),
 *  relative to `now` (assumed today, or tomorrow if that time of day has already passed). */
export function parseResetMs(text: string, now: Date = new Date()): number | undefined {
  const dur = /resets?\s+in\s+((?:\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\s*)+)/i.exec(text);
  if (dur) {
    let ms = 0;
    for (const [, n, unit] of dur[1]!.matchAll(/(\d+)\s*(h|m|s)/gi)) ms += Number(n) * ({ h: 3_600_000, m: 60_000, s: 1000 }[unit!.toLowerCase() as "h" | "m" | "s"]);
    return ms > 0 ? ms : undefined;
  }
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (clock) {
    const [, hStr, mStr, ampm] = clock;
    let h = Number(hStr) % 12;
    if (ampm!.toLowerCase() === "pm") h += 12;
    const target = new Date(now.getTime());
    target.setHours(h, mStr ? Number(mStr) : 0, 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1); // already past today: assume tomorrow
    return target.getTime() - now.getTime();
  }
  return undefined;
}

export type Cooldown = { code: string; message: string; until: number };

export class Availability {
  private state = new Map<ProviderName, Cooldown>();

  /** Records that `provider` is expired; the cooldown is clamped to 1 minute .. 24 hours. */
  mark(provider: ProviderName, code: string, message: string, now: number, cooldownMs?: number): Cooldown {
    const ms = Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, cooldownMs ?? defaultCooldownMs(code)));
    const c = { code, message, until: now + ms };
    this.state.set(provider, c);
    return c;
  }

  /** The active cooldown, or null when the provider may be used (expired entries are dropped). */
  active(provider: ProviderName, now: number): Cooldown | null {
    const c = this.state.get(provider);
    if (!c) return null;
    if (c.until <= now) {
      this.state.delete(provider);
      return null;
    }
    return c;
  }

  clear(provider?: ProviderName) {
    if (provider) this.state.delete(provider);
    else this.state.clear();
  }
}
