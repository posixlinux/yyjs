import { describe, expect, it } from "vitest";
import { calendarDateOf, daysBetweenInstants, epoch, isValidIsoDateTime } from "../../src/strategy/time.js";

describe("strategy time: epoch comparison, not string comparison", () => {
  it("treats equivalent instants written with different UTC offsets as equal", () => {
    const a = "2026-01-15T09:00:00+09:00";
    const b = "2026-01-15T00:00:00Z";
    expect(a).not.toBe(b); // the strings differ
    expect(epoch(a)).toBe(epoch(b)); // but they are the same instant
    expect(daysBetweenInstants(a, b)).toBe(0);
  });

  it("orders instants by epoch even when the lexical string order would disagree", () => {
    const actuallyLater = "2026-01-15T23:00:00-09:00"; // = 2026-01-16T08:00:00Z
    const actuallyEarlier = "2026-01-16T01:00:00+09:00"; // = 2026-01-15T16:00:00Z
    expect(actuallyEarlier > actuallyLater).toBe(true); // lexical string order says the opposite of reality
    expect(epoch(actuallyEarlier)).toBeLessThan(epoch(actuallyLater)); // epoch comparison gets it right
  });

  it("rejects datetimes without an explicit offset (bare dates, or 'Z'-less local times)", () => {
    expect(isValidIsoDateTime("2026-01-15")).toBe(false);
    expect(isValidIsoDateTime("2026-01-15T09:00:00")).toBe(false);
    expect(isValidIsoDateTime("2026-01-15T09:00:00+09:00")).toBe(true);
    expect(isValidIsoDateTime("2026-01-15T00:00:00Z")).toBe(true);
  });

  it("calendarDateOf reflects the instant's UTC calendar date, distinct from a quarter's period-end date", () => {
    expect(calendarDateOf("2026-01-15T23:59:59+09:00")).toBe("2026-01-15"); // 14:59:59Z, still Jan 15 in UTC
    expect(calendarDateOf("2026-01-15T16:00:00+09:00")).toBe("2026-01-15"); // 07:00:00Z
  });
});
