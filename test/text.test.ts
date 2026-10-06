import { describe, expect, it } from "vitest";
import { parseAsOf } from "../src/collection/text.js";

describe("parseAsOf", () => {
  it("rejects impossible calendar dates instead of rolling them over", () => {
    expect(() => parseAsOf("2026-02-30")).toThrow(/valid date/);
    expect(() => parseAsOf("2026-02-30T10:00Z")).toThrow(/valid date/);
    expect(() => parseAsOf("2026-02-30T10:00:00+09:00")).toThrow(/valid date/);
  });

  it("accepts real dates and timestamps", () => {
    expect(parseAsOf("2024-02-29").dateKst).toBe("2024-02-29");
    expect(parseAsOf("2026-01-15T00:30:00+09:00").cutoff).toBe("2026-01-14T15:30:00.000Z");
  });
});
