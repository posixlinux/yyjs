import { describe, expect, it } from "vitest";
import { configDigest, StrategyConfigSchema } from "../../src/strategy/config.js";
import { TEST_CONFIG } from "./fixture.js";

describe("strategy config: digest and required cost fields", () => {
  it("digest is stable regardless of key order and changes when any value changes", () => {
    const reordered = Object.fromEntries(Object.entries(TEST_CONFIG).reverse());
    expect(configDigest(StrategyConfigSchema.parse(reordered))).toBe(configDigest(TEST_CONFIG));
    expect(configDigest({ ...TEST_CONFIG, gapThresholdPct: 0.11 })).not.toBe(configDigest(TEST_CONFIG));
  });

  it("has no built-in default for trading costs or capital: they must always be supplied explicitly", () => {
    const { feeBpsPerSide: _f, slippageBpsPerSide: _s, sellTaxBps: _t, initialCapitalKRW: _c, ...withoutCosts } = TEST_CONFIG;
    expect(() => StrategyConfigSchema.parse(withoutCosts)).toThrow();
  });

  it("rejects an inverted prior-consensus-lag or catalyst-window range", () => {
    expect(() => StrategyConfigSchema.parse({ ...TEST_CONFIG, minPriorConsensusLagDays: 41 })).toThrow();
    expect(() => StrategyConfigSchema.parse({ ...TEST_CONFIG, catalystMinDaysAhead: 61 })).toThrow();
  });
});
