import { describe, expect, it } from "vitest";
import { parseCompetitorIds } from "../src/collection/competitors.js";
import { AnalysisRequestSchema } from "../src/domain/schema.js";

describe("competitor ids", () => {
  it("accepts new alphanumeric KRX codes like the analysed ticker does", () => {
    expect(parseCompetitorIds(["KR:000660", "kr:0009k0"])).toEqual([
      { market: "KR", code: "000660" },
      { market: "KR", code: "0009K0" },
    ]);
    expect(AnalysisRequestSchema.parse({ ticker: "005930", competitors: ["KR:0009K0"] }).competitors).toEqual(["KR:0009K0"]);
  });

  it("still rejects malformed KR codes", () => {
    expect(() => parseCompetitorIds(["KR:A00660"])).toThrow(/KR:000660/);
    expect(() => parseCompetitorIds(["KR:00066"])).toThrow(/KR:000660/);
    expect(AnalysisRequestSchema.safeParse({ ticker: "005930", competitors: ["KR:A00660"] }).success).toBe(false);
  });
});
